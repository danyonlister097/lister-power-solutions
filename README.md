# Lister Power Solutions — Job Management App

A standalone customer and job-scheduling web app for Lister Power Solutions
(electrical / air conditioning trades business). Built to replace the job-management
side of ServiceM8, run entirely on infrastructure you control.

Two roles:

- **Admin** (office) — manages customers, creates/assigns/edits jobs, manages user
  accounts.
- **Tech** (field) — logs in from a phone browser, sees only their own assigned jobs,
  and updates job status from the field.

## What it does (v1)

- **Customers** — create, search, edit, and (soft) remove customer records with
  contact details and address.
- **Jobs & scheduling** — create jobs against a customer, assign to a tech, set a
  scheduled date/time, and track status (`unscheduled → scheduled → in_progress →
  completed`, or `cancelled`). A filterable list view (Today / This Week / Upcoming /
  All, by status and by tech) stands in for a calendar for now.
- **Auth** — session-based login, admin vs. tech access control enforced at both the
  route and query level (a tech can never see another tech's job, even by guessing a
  URL).

## What it does NOT do yet (by design)

- Quotes and invoicing.
- Pushing invoices to **MYOB AccountRight** — the MYOB API client
  (`src/lib/myobClient.js`) is already built (OAuth2 refresh-token flow, customer/
  invoice upsert) but sits dormant and unwired. Wiring it up to push completed jobs as
  MYOB invoices is the natural next step once v1 is in daily use.
- Drag-and-drop calendar UI.
- Public-internet hosting for techs to reach it off your local network (VPN, reverse
  proxy, cloud hosting, TLS) — this is an infrastructure decision for later.

## 1. Prerequisites

- Node.js 22.5+ (uses the built-in `node:sqlite` module — no native compilation, no
  Visual Studio Build Tools needed on Windows)

## 2. Install

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

- `SESSION_SECRET` — any long random string (used to sign session cookies)
- `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` — the first admin account, created by
  the seed script below
- `PORT` — defaults to 3000
- `DB_FILE` — where the SQLite database file lives, defaults to `data/app.db`

Leave the `MYOB_*` variables blank and `MYOB_ENABLED=false` for now — they're not used
until MYOB push is built.

## 3. Create the first admin account

```bash
npm run seed:admin
```

Safe to re-run — it's a no-op once any admin exists.

## 4. Run it

```bash
npm start        # production
npm run dev       # auto-restart on file changes (nodemon)
```

Then visit `http://localhost:3000` and log in with the admin account you seeded. From
the Users page, create a tech account for each field technician — there's no
self-signup.

Logs go to console and to `logs/app.log` / `logs/app-error.log`.

## Project structure

```
src/
  config.js            # env/config loader
  app.js                # Express app setup (sessions, view engine, routes)
  index.js               # entrypoint — starts the HTTP server
  db/
    schema.sql            # SQLite schema (users, customers, jobs, sessions)
    index.js                # node:sqlite connection + schema init
  lib/
    logger.js               # winston logger
    passwords.js             # scrypt password hash/verify
    flash.js                  # one-time flash message helper
    sqliteSessionStore.js      # express-session store backed by node:sqlite
    myobClient.js               # MYOB AccountRight API wrapper — dormant, unused
  middleware/
    auth.js                # requireAuth / requireRole / CSRF helpers
  routes/
    auth.js, customers.js, jobs.js, users.js
  views/                  # EJS templates
public/
  css/style.css           # hand-rolled, mobile-first
scripts/
  seed-admin.js           # creates the first admin user
```

## Data model

- `users` — name, email, password hash, role (`admin`/`tech`), active.
- `customers` — name, contact, phone/email, address. Includes reserved (currently
  unused) `myob_customer_uid` / `myob_synced_at` columns for the future MYOB push.
- `jobs` — customer, title/description, status, assigned tech, scheduled start/end,
  job-site address, notes. Includes a reserved `myob_invoice_uid` column for later.

## Security notes

- Never commit `.env` — it holds the session secret and (eventually) live MYOB
  credentials.
- `data/app.db` is the entire database — back it up regularly (it's a single file, easy
  to copy).
- Run this on infrastructure you control. If you later expose it to techs' phones over
  the public internet, put it behind HTTPS.
