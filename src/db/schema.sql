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
