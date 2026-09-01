-- Postgres (Neon) schema. Datetime columns stay TEXT in the same
-- 'YYYY-MM-DD HH24:MI:SS' (UTC) shape SQLite's datetime('now') produced, so
-- every existing JS/EJS call site that parses or string-compares these
-- values keeps working unchanged. now_utc_text() centralises that format.
CREATE OR REPLACE FUNCTION now_utc_text() RETURNS TEXT AS $$
  SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
$$ LANGUAGE SQL STABLE;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'trade', 'apprentice')),
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  hourly_rate REAL,
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text()
);

-- Contact/emergency fields migration for existing databases
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'phone_personal') THEN
    ALTER TABLE users
      ADD COLUMN phone_personal TEXT,
      ADD COLUMN phone_work TEXT,
      ADD COLUMN emergency_contact_name TEXT,
      ADD COLUMN emergency_contact_phone TEXT,
      ADD COLUMN emergency_contact_relation TEXT;
  END IF;
END $$;

-- Address fields migration for existing databases
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'address_street') THEN
    ALTER TABLE users
      ADD COLUMN address_street TEXT,
      ADD COLUMN address_city TEXT,
      ADD COLUMN address_state TEXT,
      ADD COLUMN address_postcode TEXT;
  END IF;
END $$;

-- Login security migration: failed-attempt lockout + password reset tokens.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'failed_login_attempts') THEN
    ALTER TABLE users
      ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN locked_at TEXT,
      ADD COLUMN reset_token TEXT,
      ADD COLUMN reset_token_expires TEXT;
  END IF;
END $$;

-- Which of the app's page-level sections (nav links) a non-admin employee
-- can reach. Admins always have full access regardless of these rows - see
-- src/lib/permissions.js - so this table only ever holds trade/apprentice
-- grants.
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL,
  PRIMARY KEY (user_id, permission_key)
);

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  address_street TEXT,
  address_city TEXT,
  address_state TEXT,
  address_postcode TEXT,
  address_country TEXT NOT NULL DEFAULT 'Australia',
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  myob_customer_uid TEXT,
  myob_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text()
);

-- quote_id is added via ALTER below, after the quotes table exists - jobs
-- and quotes reference each other (jobs.quote_id <-> quotes.job_id), so one
-- side has to be created first and patched in, same as the old SQLite
-- migration in db/index.js did.
CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'unscheduled'
    CHECK (status IN ('unscheduled', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  assigned_to INTEGER REFERENCES users(id),
  scheduled_start TEXT,
  scheduled_end TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  site_address_street TEXT,
  site_address_city TEXT,
  site_address_state TEXT,
  site_address_postcode TEXT,
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  completed_at TEXT,
  myob_invoice_uid TEXT,
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_jobs_customer_id ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_assigned_to ON jobs(assigned_to);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled_start ON jobs(scheduled_start);

CREATE TABLE IF NOT EXISTS job_assignees (
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (job_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_job_assignees_user_id ON job_assignees(user_id);

-- filename now holds the Vercel Blob URL (was a local disk filename under
-- SQLite/multer.diskStorage).
CREATE TABLE IF NOT EXISTS job_attachments (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_job_attachments_job_id ON job_attachments(job_id);

-- No "sessions" table here - connect-pg-simple owns and creates its own
-- session table (see src/app.js).

CREATE TABLE IF NOT EXISTS clock_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('in', 'out')),
  occurred_at TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  accuracy REAL,
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_clock_events_user_id ON clock_events(user_id);
CREATE INDEX IF NOT EXISTS idx_clock_events_occurred_at ON clock_events(occurred_at);

-- One row per employee per Monday-Sunday week. The Sunday-midnight cron
-- (see api/index.js's /api/cron/generate-timesheets) inserts these as
-- 'pending' from that week's clock_events; approving (whether from the
-- auto-generated row or a week nothing was generated for) recomputes the
-- totals live and upserts status='approved', so approval is never blocked
-- by a missed/late cron run.
CREATE TABLE IF NOT EXISTS timesheets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  total_minutes REAL NOT NULL DEFAULT 0,
  regular_minutes REAL NOT NULL DEFAULT 0,
  overtime_minutes REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text(),
  UNIQUE (user_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_timesheets_status ON timesheets(status);

CREATE TABLE IF NOT EXISTS leave_requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  admin_comment TEXT,
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_leave_requests_user_id ON leave_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status);

ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS leave_type TEXT NOT NULL DEFAULT 'annual';

CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  assigned_to INTEGER REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  done INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_done ON tasks(done);

CREATE TABLE IF NOT EXISTS chat_channels (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES chat_channels(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_id ON chat_messages(channel_id);

CREATE TABLE IF NOT EXISTS chat_reads (
  user_id INTEGER NOT NULL REFERENCES users(id),
  channel_id INTEGER NOT NULL REFERENCES chat_channels(id),
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);

-- Per-user channel sidebar customisation: pin status and manual drag order.
-- No row means "not pinned, ordered by channel id" (see chat.js).
CREATE TABLE IF NOT EXISTS chat_channel_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id),
  channel_id INTEGER NOT NULL REFERENCES chat_channels(id),
  pinned INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER,
  PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS photo_folders (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_photo_folders_customer_id ON photo_folders(customer_id);

-- filename now holds the Vercel Blob URL.
CREATE TABLE IF NOT EXISTS photo_folder_images (
  id SERIAL PRIMARY KEY,
  folder_id INTEGER NOT NULL REFERENCES photo_folders(id),
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_photo_folder_images_folder_id ON photo_folder_images(folder_id);

-- Blank form/report/certificate templates, managed by admins. filename holds
-- the Vercel Blob URL; this blob is never overwritten - "Create new" always
-- makes a fresh, independent blob copy.
CREATE TABLE IF NOT EXISTS form_templates (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

-- A duplicate created from a form_template. Its filename points at its own
-- independent Blob copy, so filling it in / replacing it with a completed
-- scan never touches the template. job_id is nullable: a form created via
-- the "+" on the general Forms tab starts as an unassigned draft and is
-- only linked to a job once the user saves it and picks one.
CREATE TABLE IF NOT EXISTS job_forms (
  id SERIAL PRIMARY KEY,
  job_id INTEGER REFERENCES jobs(id),
  template_id INTEGER REFERENCES form_templates(id),
  name TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_job_forms_job_id ON job_forms(job_id);
CREATE INDEX IF NOT EXISTS idx_job_forms_template_id ON job_forms(template_id);

-- --- Job costing ---
-- (created before Inventory below, since job_stock_allocations references
-- job_cost_items - Postgres validates FK targets exist at CREATE TABLE
-- time, unlike SQLite)

CREATE TABLE IF NOT EXISTS job_costs (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id),
  quoted_amount REAL,
  updated_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE TABLE IF NOT EXISTS job_cost_items (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  category TEXT NOT NULL CHECK (category IN ('labour', 'material', 'subcontractor', 'travel', 'other')),
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_cost REAL NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_job_cost_items_job_id ON job_cost_items(job_id);

-- --- Inventory ---

CREATE TABLE IF NOT EXISTS inventory_items (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'each',
  quantity_on_hand REAL NOT NULL DEFAULT 0,
  reorder_threshold REAL,
  unit_cost REAL, -- ex-GST: the real cost for job costing/profit (GST paid on purchases is normally claimed back)
  unit_cost_inc_gst REAL, -- inc-GST: informational, e.g. for cash-flow/budgeting
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_inventory_items_name ON inventory_items(name);

-- One row per allocation event - decrements inventory_items.quantity_on_hand
-- and (when the job has costing enabled) mirrors into job_cost_items so
-- stock used on a job shows up as a material cost automatically.
CREATE TABLE IF NOT EXISTS job_stock_allocations (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  quantity REAL NOT NULL,
  cost_item_id INTEGER REFERENCES job_cost_items(id),
  allocated_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_job_stock_allocations_job_id ON job_stock_allocations(job_id);
CREATE INDEX IF NOT EXISTS idx_job_stock_allocations_item_id ON job_stock_allocations(item_id);

-- Supplier product code stored on inventory items so CNW invoice imports can
-- auto-match by code on future imports after the first manual match.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_items' AND column_name = 'supplier_code') THEN
    ALTER TABLE inventory_items ADD COLUMN supplier_code TEXT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_items_supplier_code ON inventory_items(supplier_code);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_items' AND column_name = 'minimum_stock') THEN
    ALTER TABLE inventory_items ADD COLUMN minimum_stock REAL;
  END IF;
END $$;

-- One row per processed invoice email - used to prevent double-importing the
-- same invoice and to give admins a visible audit trail of what came in.
CREATE TABLE IF NOT EXISTS invoice_imports (
  id SERIAL PRIMARY KEY,
  invoice_number TEXT NOT NULL,
  supplier TEXT NOT NULL DEFAULT 'CNW',
  email_message_id TEXT,
  lines_total INTEGER NOT NULL DEFAULT 0,
  lines_matched INTEGER NOT NULL DEFAULT 0,
  lines_unmatched INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_imports_number ON invoice_imports(invoice_number, supplier);

-- --- Asset management ---

CREATE TABLE IF NOT EXISTS customer_assets (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  make TEXT,
  model TEXT,
  serial_number TEXT,
  install_date TEXT,
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_customer_assets_customer_id ON customer_assets(customer_id);

-- Which assets were serviced on a given job - lets a tech click an asset on
-- a customer's record and instantly see its full service history.
CREATE TABLE IF NOT EXISTS job_assets (
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  asset_id INTEGER NOT NULL REFERENCES customer_assets(id),
  PRIMARY KEY (job_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_job_assets_asset_id ON job_assets(asset_id);

-- --- Business asset register ---
-- The company's own tools/equipment (power tools, ladders, HVAC gear, test
-- equipment, etc.) - distinct from customer_assets, which tracks equipment
-- installed at a customer's site.

-- Admin-managed picklist of category names offered on the asset form. Seeded
-- with a starter set the first time this table is created (see db/index.js);
-- admins can add more from the Asset Register page.
CREATE TABLE IF NOT EXISTS business_asset_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE TABLE IF NOT EXISTS business_assets (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  serial_number TEXT,
  purchase_date TEXT,
  purchase_cost REAL,
  assigned_to INTEGER REFERENCES users(id),
  location TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'in_repair', 'retired', 'lost')),
  next_service_due TEXT,
  registration_expiry TEXT,
  current_odometer_km REAL,
  service_due_at_km REAL,
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_business_assets_category ON business_assets(category);
CREATE INDEX IF NOT EXISTS idx_business_assets_assigned_to ON business_assets(assigned_to);

-- Asset numbering migration: add column if it doesn't exist yet, then backfill
-- existing rows so every asset always has a number.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'business_assets' AND column_name = 'asset_number'
  ) THEN
    ALTER TABLE business_assets ADD COLUMN asset_number INTEGER;
  END IF;
END $$;

UPDATE business_assets
SET asset_number = sub.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
  FROM business_assets
  WHERE asset_number IS NULL
) sub
WHERE business_assets.id = sub.id;

-- --- Quoting ---
-- A quote is customer-facing pricing sent before a job exists. Accepting one
-- creates the job (jobs.quote_id links back) and carries its total across as
-- the job's quoted_amount, so Job Costing's profit figure lines up with what
-- was actually quoted.

CREATE TABLE IF NOT EXISTS quotes (
  id SERIAL PRIMARY KEY,
  quote_number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  job_id INTEGER REFERENCES jobs(id),
  title TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'declined')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  sent_at TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_quotes_customer_id ON quotes(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);

-- jobs.quote_id: added here (rather than in the jobs CREATE TABLE above)
-- because it references quotes(id), and quotes.job_id references jobs(id) -
-- one side of this circular FK has to be patched in after both tables exist.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS quote_id INTEGER REFERENCES quotes(id);

-- N/A flags let users bypass the photo/stock completion requirements when
-- they genuinely don't apply to a particular job (e.g. a call-out with no
-- materials used, or an internal job where photos aren't needed).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS photos_na INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS stock_na INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS actual_start TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS actual_end TEXT;

CREATE TABLE IF NOT EXISTS quote_items (
  id SERIAL PRIMARY KEY,
  quote_id INTEGER NOT NULL REFERENCES quotes(id),
  category TEXT NOT NULL CHECK (category IN ('labour', 'material', 'subcontractor', 'travel', 'other')),
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_quote_items_quote_id ON quote_items(quote_id);

-- --- Invoicing ---
-- Invoice line items are a snapshot, independent of job_cost_items (which
-- track internal cost for profit tracking, not the customer-facing price) -
-- copying a job's cost items across when an invoice is created just saves
-- retyping; the admin adjusts to the actual billed price before sending.

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  invoice_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'cancelled')),
  issue_date TEXT NOT NULL,
  due_date TEXT,
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_invoices_job_id ON invoices(job_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

CREATE TABLE IF NOT EXISTS invoice_items (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  category TEXT NOT NULL CHECK (category IN ('labour', 'material', 'subcontractor', 'travel', 'other')),
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items(invoice_id);

-- --- Bug reports / ideas ---

CREATE TABLE IF NOT EXISTS feedback_items (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('bug', 'idea')),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'declined')),
  submitted_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_feedback_items_status ON feedback_items(status);

-- date_of_birth for birthday milestone tracking on the dashboard
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_start_date TEXT;

-- Smart follow-up emails sent to customers after job completion
CREATE TABLE IF NOT EXISTS job_followups (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  follow_up_type TEXT NOT NULL CHECK (follow_up_type IN ('6month', '12month')),
  scheduled_at TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);
CREATE INDEX IF NOT EXISTS idx_job_followups_scheduled ON job_followups(scheduled_at) WHERE sent_at IS NULL;

-- Renewal / compliance tracking: licences, training, rego, insurance, compliance docs
CREATE TABLE IF NOT EXISTS renewals (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  asset_id INTEGER REFERENCES business_assets(id) ON DELETE SET NULL,
  expiry_date TEXT NOT NULL,
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_renewals_expiry_date ON renewals(expiry_date);
CREATE INDEX IF NOT EXISTS idx_renewals_category ON renewals(category);

-- Custom business milestones (project deadlines, certifications, anniversaries, etc.)
CREATE TABLE IF NOT EXISTS milestones (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  recurrence TEXT NOT NULL DEFAULT 'once' CHECK (recurrence IN ('once', 'annual')),
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_milestones_date ON milestones(date);

-- Geocoded coordinates for smart scheduling (populated on demand via Google Maps API)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lat REAL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lng REAL;

-- Bills (accounts payable): supplier/contractor invoices received for stock, labour, etc.
CREATE TABLE IF NOT EXISTS bills (
  id SERIAL PRIMARY KEY,
  supplier TEXT NOT NULL,
  supplier_invoice_number TEXT,
  invoice_date TEXT NOT NULL,
  due_date TEXT,
  amount_ex_gst REAL NOT NULL DEFAULT 0,
  gst REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('stock', 'contractor', 'subcontractor', 'utilities', 'other')),
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'paid')),
  notes TEXT,
  file_url TEXT,
  file_name TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text()
);
CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(status);
CREATE INDEX IF NOT EXISTS idx_bills_invoice_date ON bills(invoice_date);

-- MYOB OAuth tokens - one row, updated in place on each token refresh.
CREATE TABLE IF NOT EXISTS myob_tokens (
  id SERIAL PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  company_file_id TEXT,
  company_file_uri TEXT,
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text()
);

-- Track which MYOB invoice UID corresponds to a local invoice after push.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS myob_invoice_uid TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS myob_emailed_at TEXT;

ALTER TABLE chat_channels ADD COLUMN IF NOT EXISTS locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_channels ADD COLUMN IF NOT EXISTS admin_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachment_url TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachment_name TEXT;

-- Admin-managed category list for the Renewals tool.
-- Seeded with defaults in db/index.js ensureSeedData(); admins can add/delete.
CREATE TABLE IF NOT EXISTS renewal_categories (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

-- Expected job length in minutes, set before a specific time slot is known -
-- Smart Schedule uses this (falling back to a default) to size each job's
-- slot and pack a day's work up to its 6-hour cap.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;

-- Documents/Licensing tab on the Renewals page - a filing cabinet for the
-- actual license/compliance document (photo or PDF), separate from the
-- expiry-reminder list in `renewals`. expiry_date is optional here since
-- not every filed document expires.
CREATE TABLE IF NOT EXISTS license_documents (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  license_number TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expiry_date TEXT,
  notes TEXT,
  file_url TEXT,
  file_name TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT now_utc_text(),
  updated_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_license_documents_expiry_date ON license_documents(expiry_date);

-- Per-admin preferred order of dashboard widgets, as a JSON array of widget
-- keys (see DEFAULT_WIDGET_ORDER in routes/dashboard.js). NULL means "use
-- the default order" - nothing to migrate for users who never touch it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS dashboard_layout TEXT;

-- Trade category (Electrical, Air Conditioning, Solar, Handyman, ...) set at
-- job creation - lets the Jobs list be filtered by kind of work, separate
-- from status/date range. See JOB_CATEGORIES in routes/jobs.js.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS category TEXT;

-- When set, this document is also surfaced on the Renewals tab as an
-- expiry-tracked item (live-joined in GET /renewals, not copied) - so a
-- licence/document only has to be entered once instead of twice.
ALTER TABLE license_documents ADD COLUMN IF NOT EXISTS create_renewal INTEGER NOT NULL DEFAULT 0;

-- "Invoiced" job status - sales invoicing now happens solely through MYOB,
-- so there's no more in-app invoice record to auto-detect a job's been
-- billed. This is a manually-set terminal status after Completed instead.
-- A plain CREATE TABLE IF NOT EXISTS can't widen an existing CHECK, so the
-- constraint is dropped and recreated (safe/idempotent - same definition
-- every time this file runs).
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('unscheduled', 'scheduled', 'in_progress', 'completed', 'invoiced', 'cancelled'));

-- Remembers a verdict against a duplicate-job match (see findDuplicateJobIds
-- in routes/jobs.js) so the same call doesn't have to be made twice. Keyed
-- by the match itself (a work-order number, or a description's text) rather
-- than a pair of job IDs, since that's what the decision is really about -
-- if a third job later reuses the same number, the earlier verdict applies
-- to it too. Only the latest verdict per key is kept (no history).
CREATE TABLE IF NOT EXISTS job_duplicate_decisions (
  id SERIAL PRIMARY KEY,
  match_type TEXT NOT NULL CHECK (match_type IN ('number', 'description')),
  match_key TEXT NOT NULL,
  is_duplicate INTEGER NOT NULL,
  reason TEXT,
  decided_by INTEGER NOT NULL REFERENCES users(id),
  decided_at TEXT NOT NULL DEFAULT now_utc_text(),
  UNIQUE (match_type, match_key)
);

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS pinned_by INTEGER REFERENCES users(id);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS pinned_at TEXT;
-- Nullable self-reference for "reply to this message". ON DELETE SET NULL
-- so deleting the original message never fails/cascades - a reply just
-- quietly loses its quoted preview instead of blocking the delete or
-- taking the reply down with it.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL;

-- Web Push subscriptions - one row per device/browser a user has enabled
-- notifications on (a user can have several: phone + desktop). endpoint is
-- unique per device registration, so re-subscribing the same device just
-- updates its keys rather than creating a duplicate row.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

-- Tracks whether each of the two bill-due push reminders (a few days out,
-- and on the day itself) has already fired, so the daily cron doesn't
-- re-notify for the same bill every time it runs.
ALTER TABLE bills ADD COLUMN IF NOT EXISTS reminder_soon_sent_at TEXT;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS reminder_due_sent_at TEXT;

-- Field-level edit history for jobs - one row per edit event that actually
-- changed something, `changes` a JSON array of {field, from, to} display
-- strings (already human-readable, not raw column values). Who/when a job
-- was *created* lives on jobs.created_by/created_at directly, so there's no
-- separate "created" row here. user_id is nullable (ON DELETE SET NULL) so
-- deleting a user never breaks old entries, just shows no name for them.
CREATE TABLE IF NOT EXISTS job_history (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changes TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_job_history_job_id ON job_history(job_id);

-- Stock can never go below zero - every code path that decrements
-- quantity_on_hand now floors at 0 (GREATEST(quantity_on_hand - x, 0)); this
-- is the backstop against any path that doesn't. NOT VALID skips checking
-- pre-existing rows, since some are already negative from before this floor
-- existed - so this can't fail to apply on a database that isn't clean yet.
-- New/updated rows are enforced immediately either way.
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_quantity_non_negative;
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_quantity_non_negative
  CHECK (quantity_on_hand >= 0) NOT VALID;

-- Quote documents attached to a job (under Job costing) - separate from the
-- numeric quoted_amount on job_costs, this is the actual file sent to the
-- customer. Same one-row-per-file shape as job_attachments, since a job can
-- have more than one (an initial quote, a later revision, etc).
CREATE TABLE IF NOT EXISTS job_quote_files (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT now_utc_text()
);

CREATE INDEX IF NOT EXISTS idx_job_quote_files_job_id ON job_quote_files(job_id);
