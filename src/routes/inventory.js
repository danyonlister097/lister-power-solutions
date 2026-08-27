const express = require('express');
const db = require('../db');
const { requireRole, verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');
const { asyncHandler } = require('../lib/asyncHandler');

const router = express.Router();

async function getCategories() {
  return (
    await db.prepare('SELECT DISTINCT category FROM inventory_items WHERE category IS NOT NULL ORDER BY category').all()
  ).map((r) => r.category);
}

// "+ Add new category..." in the category <select> lets a new category be
// typed in on the spot instead of needing a separate management screen -
// matches the same pattern already used for Asset Register categories.
// Re-uses an existing category (case-insensitively) rather than creating a
// near-duplicate if one already matches.
function resolveCategory(body, categories) {
  if (body.category === '__new__') {
    const newName = (body.new_category || '').trim();
    if (!newName) return null;
    const existing = categories.find((c) => c.toLowerCase() === newName.toLowerCase());
    return existing || newName;
  }
  return categories.includes(body.category) ? body.category : null;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const items = await db.prepare('SELECT * FROM inventory_items ORDER BY name ASC').all();

    // Items with stock on hand but no movement in 90 days — potential dead stock.
    const cutoff90 = new Date();
    cutoff90.setDate(cutoff90.getDate() - 90);
    const cutoff90Str = cutoff90.toISOString();
    const deadStockRows = await db
      .prepare(
        `SELECT i.id FROM inventory_items i
         WHERE i.quantity_on_hand > 0
           AND NOT EXISTS (
             SELECT 1 FROM job_stock_allocations a
             WHERE a.item_id = i.id AND a.created_at >= ?
           )`
      )
      .all(cutoff90Str);
    const deadStockIds = new Set(deadStockRows.map((r) => r.id));

    let stockValueEx = 0;
    let stockValueInc = 0;
    let stockItemCount = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;
    let unpricedCount = 0;
    for (const item of items) {
      if (item.quantity_on_hand > 0) {
        stockItemCount++;
        if (item.unit_cost !== null) {
          stockValueEx += item.unit_cost * item.quantity_on_hand;
          const incRate = item.unit_cost_inc_gst !== null ? item.unit_cost_inc_gst : item.unit_cost * 1.1;
          stockValueInc += incRate * item.quantity_on_hand;
        }
        if (item.reorder_threshold !== null && item.quantity_on_hand <= item.reorder_threshold) lowStockCount++;
      } else {
        outOfStockCount++;
      }
      if (item.unit_cost === null) unpricedCount++;
    }
    res.render('inventory/index', {
      title: 'Inventory',
      items,
      categories: await getCategories(),
      stockValueEx,
      stockValueInc,
      stockItemCount,
      lowStockCount,
      outOfStockCount,
      unpricedCount,
      deadStockCount: deadStockIds.size,
      deadStockIds: [...deadStockIds],
    });
  })
);

router.post(
  '/',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) {
      setFlash(req, 'error', 'Item name is required.');
      return res.redirect('/inventory');
    }

    await db
      .prepare(
        `INSERT INTO inventory_items (name, category, unit, quantity_on_hand, reorder_threshold, minimum_stock, unit_cost, unit_cost_inc_gst)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        name,
        resolveCategory(req.body, await getCategories()),
        (req.body.unit || 'each').trim(),
        Number.parseFloat(req.body.quantity_on_hand) || 0,
        req.body.reorder_threshold ? Number.parseFloat(req.body.reorder_threshold) : null,
        req.body.minimum_stock ? Number.parseFloat(req.body.minimum_stock) : null,
        req.body.unit_cost ? Number.parseFloat(req.body.unit_cost) : null,
        req.body.unit_cost_inc_gst ? Number.parseFloat(req.body.unit_cost_inc_gst) : null
      );

    setFlash(req, 'success', `"${name}" added to inventory.`);
    res.redirect('/inventory');
  })
);

// Registered before the /:id routes below so "bulk-delete" isn't swallowed
// as an item id. Same allocation-history guard as the single-item delete -
// items with stock allocation history are skipped rather than blocking the
// whole batch, so one in-use item doesn't stop the rest from being removed.
router.post(
  '/bulk-delete',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const ids = []
      .concat(req.body.item_ids || [])
      .map((id) => Number.parseInt(id, 10))
      .filter(Number.isFinite);

    if (!ids.length) {
      setFlash(req, 'error', 'No items selected.');
      return res.redirect('/inventory');
    }

    const placeholders = ids.map(() => '?').join(',');
    const inUseIds = new Set(
      (await db.prepare(`SELECT DISTINCT item_id FROM job_stock_allocations WHERE item_id IN (${placeholders})`).all(...ids)).map(
        (r) => r.item_id
      )
    );
    const deletableIds = ids.filter((id) => !inUseIds.has(id));

    if (deletableIds.length) {
      const delPlaceholders = deletableIds.map(() => '?').join(',');
      await db.prepare(`DELETE FROM inventory_items WHERE id IN (${delPlaceholders})`).run(...deletableIds);
    }

    const skipped = ids.length - deletableIds.length;
    let message = `${deletableIds.length} item${deletableIds.length === 1 ? '' : 's'} deleted.`;
    if (skipped) message += ` ${skipped} skipped (has allocation history).`;
    setFlash(req, deletableIds.length ? 'success' : 'error', message);
    res.redirect('/inventory');
  })
);

// Allocating stock to a job also drops a matching material line into that
// job's costing (if the item has a unit cost), so stock use and job
// profitability stay in sync automatically.
// Registered before the /:id routes below so "allocate" isn't swallowed
// as an item id.
router.post(
  '/allocate',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const job = await db.prepare('SELECT id, title FROM jobs WHERE id = ?').get(req.body.job_id);
    const item = await db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.body.item_id);
    const quantity = Number.parseFloat(req.body.quantity);

    if (!job || !item || !Number.isFinite(quantity) || quantity <= 0) {
      setFlash(req, 'error', 'Please choose an item and a valid quantity.');
      return res.redirect(job ? `/jobs/${job.id}` : '/inventory');
    }

    if (quantity > item.quantity_on_hand) {
      setFlash(req, 'error', `Only ${item.quantity_on_hand} ${item.unit} of "${item.name}" available in stock.`);
      return res.redirect(`/jobs/${job.id}`);
    }

    await db
      .prepare(`UPDATE inventory_items SET quantity_on_hand = GREATEST(quantity_on_hand - ?, 0), updated_at = datetime('now') WHERE id = ?`)
      .run(quantity, item.id);

    let costItemId = null;
    if (item.unit_cost !== null) {
      const result = await db
        .prepare(
          `INSERT INTO job_cost_items (job_id, category, description, quantity, unit_cost, created_by)
           VALUES (?, 'material', ?, ?, ?, ?)
           RETURNING id`
        )
        .run(job.id, item.name, quantity, item.unit_cost, req.user.id);
      costItemId = result.lastInsertRowid;
    }

    await db
      .prepare(`INSERT INTO job_stock_allocations (job_id, item_id, quantity, cost_item_id, allocated_by) VALUES (?, ?, ?, ?, ?)`)
      .run(job.id, item.id, quantity, costItemId, req.user.id);

    setFlash(req, 'success', `${quantity} ${item.unit} of "${item.name}" allocated to ${job.title}.`);
    res.redirect(`/jobs/${job.id}`);
  })
);

// Undoes an allocation mistake (wrong item/quantity) - puts the stock back
// and removes the auto-created material cost line, if any. Open to anyone
// who could allocate in the first place (matches /allocate above), not
// admin-only, since any team member on the job can misclick and needs to
// fix it themselves.
router.post(
  '/allocations/:id/delete',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const allocation = await db.prepare('SELECT * FROM job_stock_allocations WHERE id = ?').get(req.params.id);
    if (!allocation) return res.status(404).render('error', { message: 'Allocation not found.' });

    await db
      .prepare(`UPDATE inventory_items SET quantity_on_hand = quantity_on_hand + ?, updated_at = datetime('now') WHERE id = ?`)
      .run(allocation.quantity, allocation.item_id);

    // The allocation row references cost_item_id, so it must go first or the
    // FK constraint blocks deleting the job_cost_items row underneath it.
    await db.prepare('DELETE FROM job_stock_allocations WHERE id = ?').run(allocation.id);

    if (allocation.cost_item_id) {
      await db.prepare('DELETE FROM job_cost_items WHERE id = ?').run(allocation.cost_item_id);
    }

    setFlash(req, 'success', 'Stock allocation removed.');
    res.redirect(`/jobs/${allocation.job_id}`);
  })
);

router.post(
  '/allocations/:id/update',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const allocation = await db.prepare('SELECT * FROM job_stock_allocations WHERE id = ?').get(req.params.id);
    if (!allocation) return res.status(404).render('error', { message: 'Allocation not found.' });

    const newQty = parseFloat(req.body.quantity);
    if (isNaN(newQty) || newQty <= 0) {
      setFlash(req, 'error', 'Quantity must be greater than zero.');
      return res.redirect(`/jobs/${allocation.job_id}`);
    }

    const diff = newQty - allocation.quantity;
    if (diff !== 0) {
      if (diff > 0) {
        const item = await db.prepare('SELECT quantity_on_hand FROM inventory_items WHERE id = ?').get(allocation.item_id);
        if (diff > item.quantity_on_hand) {
          setFlash(req, 'error', `Only ${item.quantity_on_hand} units available in inventory.`);
          return res.redirect(`/jobs/${allocation.job_id}`);
        }
      }
      await db
        .prepare(`UPDATE inventory_items SET quantity_on_hand = GREATEST(quantity_on_hand - ?, 0), updated_at = datetime('now') WHERE id = ?`)
        .run(diff, allocation.item_id);
      await db.prepare('UPDATE job_stock_allocations SET quantity = ? WHERE id = ?').run(newQty, allocation.id);
      if (allocation.cost_item_id) {
        await db.prepare('UPDATE job_cost_items SET quantity = ? WHERE id = ?').run(newQty, allocation.cost_item_id);
      }
    }

    res.redirect(`/jobs/${allocation.job_id}`);
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const item = await db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).render('error', { message: 'Item not found.' });

    const allocations = await db
      .prepare(
        `SELECT job_stock_allocations.*, jobs.title AS job_title, users.name AS allocated_by_name
         FROM job_stock_allocations
         JOIN jobs ON jobs.id = job_stock_allocations.job_id
         JOIN users ON users.id = job_stock_allocations.allocated_by
         WHERE job_stock_allocations.item_id = ?
         ORDER BY job_stock_allocations.created_at DESC LIMIT 50`
      )
      .all(item.id);

    // Every stock allocation to a job is a "movement" out of inventory - these
    // aggregates (all-time vs last 90 days) are what let an admin spot dead or
    // slow-moving stock at a glance, instead of scrolling the raw history.
    const movementTotals = await db
      .prepare(
        `SELECT COUNT(*) AS totalCount, COALESCE(SUM(quantity), 0) AS totalQty, MAX(created_at) AS lastMovementAt
         FROM job_stock_allocations WHERE item_id = ?`
      )
      .get(item.id);
    const recentTotals = await db
      .prepare(
        `SELECT COUNT(*) AS recentCount, COALESCE(SUM(quantity), 0) AS recentQty
         FROM job_stock_allocations WHERE item_id = ? AND created_at >= datetime('now', '-90 days')`
      )
      .get(item.id);
    const daysSinceLastMovement = movementTotals.lastMovementAt
      ? Math.floor((Date.now() - new Date(movementTotals.lastMovementAt).getTime()) / 86400000)
      : null;

    const movements = {
      lastMovementAt: movementTotals.lastMovementAt,
      daysSinceLastMovement,
      totalCount: movementTotals.totalCount,
      totalQty: movementTotals.totalQty,
      recentCount: recentTotals.recentCount,
      recentQty: recentTotals.recentQty,
    };

    res.render('inventory/show', {
      title: item.name,
      item,
      allocations,
      movements,
      categories: await getCategories(),
      error: null,
    });
  })
);

router.post(
  '/:id',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const item = await db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).render('error', { message: 'Item not found.' });

    const name = (req.body.name || '').trim();
    if (!name) {
      setFlash(req, 'error', 'Item name is required.');
      return res.redirect(`/inventory/${item.id}`);
    }

    await db
      .prepare(
        `UPDATE inventory_items SET name = ?, category = ?, unit = ?, reorder_threshold = ?, minimum_stock = ?, unit_cost = ?, unit_cost_inc_gst = ?, supplier_code = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(
        name,
        resolveCategory(req.body, await getCategories()),
        (req.body.unit || 'each').trim(),
        req.body.reorder_threshold ? Number.parseFloat(req.body.reorder_threshold) : null,
        req.body.minimum_stock ? Number.parseFloat(req.body.minimum_stock) : null,
        req.body.unit_cost ? Number.parseFloat(req.body.unit_cost) : null,
        req.body.unit_cost_inc_gst ? Number.parseFloat(req.body.unit_cost_inc_gst) : null,
        (req.body.supplier_code || '').trim() || null,
        item.id
      );

    setFlash(req, 'success', 'Item updated.');
    res.redirect('/inventory');
  })
);

router.post(
  '/:id/adjust',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const item = await db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).render('error', { message: 'Item not found.' });

    const newQty = Number.parseFloat(req.body.new_quantity);
    if (!Number.isFinite(newQty) || newQty < 0) {
      setFlash(req, 'error', 'Enter a valid quantity.');
      return res.redirect(`/inventory/${item.id}`);
    }

    const delta = newQty - item.quantity_on_hand;

    await db
      .prepare(`UPDATE inventory_items SET quantity_on_hand = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(newQty, item.id);

    const changeDesc = delta === 0 ? 'unchanged' : (delta > 0 ? `increased by ${delta}` : `decreased by ${Math.abs(delta)}`);
    setFlash(req, 'success', `Stock ${changeDesc}. Now: ${newQty} ${item.unit}.`);
    res.redirect(`/inventory/${item.id}`);
  })
);

router.post(
  '/:id/duplicate',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const item = await db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).render('error', { message: 'Item not found.' });

    const newName = `${item.name} (copy)`;
    await db
      .prepare(
        `INSERT INTO inventory_items (name, supplier_code, category, unit, quantity_on_hand, reorder_threshold, unit_cost, unit_cost_inc_gst)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(newName, item.supplier_code, item.category, item.unit, 0, item.reorder_threshold, item.unit_cost, item.unit_cost_inc_gst);

    setFlash(req, 'success', `"${newName}" created — edit it to update the details.`);
    res.redirect('/inventory');
  })
);

router.post(
  '/:id/delete',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const item = await db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).render('error', { message: 'Item not found.' });

    const inUse = await db.prepare('SELECT COUNT(*) AS n FROM job_stock_allocations WHERE item_id = ?').get(item.id);
    if (inUse.n > 0) {
      setFlash(req, 'error', 'This item has allocation history and cannot be deleted. Set its stock to 0 instead.');
      return res.redirect(`/inventory/${item.id}`);
    }

    await db.prepare('DELETE FROM inventory_items WHERE id = ?').run(item.id);
    setFlash(req, 'success', `"${item.name}" removed from inventory.`);
    res.redirect('/inventory');
  })
);

module.exports = router;
