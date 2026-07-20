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
    res.render('inventory/index', { title: 'Inventory', items, categories: await getCategories() });
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
        `INSERT INTO inventory_items (name, category, unit, quantity_on_hand, reorder_threshold, unit_cost, unit_cost_inc_gst)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        name,
        resolveCategory(req.body, await getCategories()),
        (req.body.unit || 'each').trim(),
        Number.parseFloat(req.body.quantity_on_hand) || 0,
        req.body.reorder_threshold ? Number.parseFloat(req.body.reorder_threshold) : null,
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

    await db
      .prepare(`UPDATE inventory_items SET quantity_on_hand = quantity_on_hand - ?, updated_at = datetime('now') WHERE id = ?`)
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
        `UPDATE inventory_items SET name = ?, category = ?, unit = ?, reorder_threshold = ?, unit_cost = ?, unit_cost_inc_gst = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(
        name,
        resolveCategory(req.body, await getCategories()),
        (req.body.unit || 'each').trim(),
        req.body.reorder_threshold ? Number.parseFloat(req.body.reorder_threshold) : null,
        req.body.unit_cost ? Number.parseFloat(req.body.unit_cost) : null,
        req.body.unit_cost_inc_gst ? Number.parseFloat(req.body.unit_cost_inc_gst) : null,
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

    const delta = Number.parseFloat(req.body.delta);
    if (!Number.isFinite(delta) || delta === 0) {
      setFlash(req, 'error', 'Enter a non-zero quantity to adjust.');
      return res.redirect(`/inventory/${item.id}`);
    }

    await db
      .prepare(`UPDATE inventory_items SET quantity_on_hand = quantity_on_hand + ?, updated_at = datetime('now') WHERE id = ?`)
      .run(delta, item.id);

    setFlash(req, 'success', `Stock ${delta > 0 ? 'increased' : 'decreased'} by ${Math.abs(delta)}.`);
    res.redirect(`/inventory/${item.id}`);
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
