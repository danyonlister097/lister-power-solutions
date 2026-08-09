const axios = require('axios');
const { myob } = require('../config');
const logger = require('./logger');

const TOKEN_URL = 'https://secure.myob.com/oauth2/v1/authorize/token';
const API_BASE  = myob.baseUrl || 'https://api.myob.com/accountright';

class MyobClient {
  constructor() {
    // In-memory cache — populated from DB or env on first use
    this._accessToken = null;
    this._tokenExpiresAt = 0;
    // db injected lazily to avoid circular-require issues
    this._db = null;

    this.http = axios.create({ timeout: 20000 });
    this.http.interceptors.request.use(async (cfg) => {
      const { token, cfUri } = await this._resolveAuth();
      cfg.baseURL = cfUri;
      cfg.headers.Authorization        = `Bearer ${token}`;
      cfg.headers['x-myobapi-key']     = myob.clientId;
      cfg.headers['x-myobapi-version'] = 'v2';
      cfg.headers.Accept               = 'application/json';
      cfg.headers['Content-Type']      = 'application/json';
      if (myob.companyFileUsername) {
        cfg.headers['x-myobapi-cftoken'] = Buffer.from(
          `${myob.companyFileUsername}:${myob.companyFilePassword}`
        ).toString('base64');
      }
      return cfg;
    });

    this.http.interceptors.response.use(
      (res) => res,
      (err) => {
        logger.error('MYOB API error', {
          url: err.config?.url,
          status: err.response?.status,
          data: err.response?.data,
        });
        throw err;
      }
    );
  }

  _getDb() {
    if (!this._db) this._db = require('../db');
    return this._db;
  }

  // Returns { token, cfUri } — token is fresh, cfUri is the company file base URL.
  async _resolveAuth() {
    const token = await this.getAccessToken();
    const cfUri = await this._getCompanyFileUri(token);
    return { token, cfUri };
  }

  async getAccessToken() {
    const now = Date.now();
    if (this._accessToken && now < this._tokenExpiresAt - 60_000) {
      return this._accessToken;
    }

    // Try DB first, then fall back to env refresh token
    const db = this._getDb();
    const stored = await db.prepare('SELECT * FROM myob_tokens ORDER BY id DESC LIMIT 1').get();
    const refreshToken = stored?.refresh_token || myob.refreshToken;

    if (!refreshToken) throw new Error('MYOB not connected — no refresh token available.');

    const params = new URLSearchParams({
      client_id:     myob.clientId,
      client_secret: myob.clientSecret,
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    });

    const { data } = await axios.post(TOKEN_URL, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    this._accessToken    = data.access_token;
    this._tokenExpiresAt = Date.now() + data.expires_in * 1000;

    // Persist updated tokens to DB
    const expiresAt = new Date(this._tokenExpiresAt).toISOString();
    if (stored) {
      await db
        .prepare('UPDATE myob_tokens SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = now_utc_text() WHERE id = ?')
        .run(data.access_token, data.refresh_token || refreshToken, expiresAt, stored.id);
    }

    return this._accessToken;
  }

  async _getCompanyFileUri(token) {
    const db = this._getDb();
    const stored = await db.prepare('SELECT company_file_uri FROM myob_tokens ORDER BY id DESC LIMIT 1').get();
    if (stored?.company_file_uri) return stored.company_file_uri;

    // Auto-discover: list company files and pick the first
    const { data: files } = await axios.get(API_BASE + '/', {
      headers: {
        Authorization:       `Bearer ${token}`,
        'x-myobapi-key':     myob.clientId,
        'x-myobapi-version': 'v2',
        Accept:              'application/json',
      },
    });

    if (!files || !files.length) throw new Error('No MYOB company files found.');
    const uri = files[0].Uri;

    await db
      .prepare('UPDATE myob_tokens SET company_file_uri = ?, company_file_id = ?, updated_at = now_utc_text() WHERE id = (SELECT id FROM myob_tokens ORDER BY id DESC LIMIT 1)')
      .run(uri, files[0].Id);

    return uri;
  }

  // ── Contacts ──────────────────────────────────────────────────────────────

  async listCustomers() {
    const { data } = await this.http.get('/Contact/Customer', {
      params: { '$filter': "IsActive eq true", '$top': 1000 },
    });
    return data.Items || [];
  }

  async findCustomerByName(name) {
    const filter = `Name eq '${name.replace(/'/g, "''")}'`;
    const { data } = await this.http.get('/Contact/Customer', { params: { $filter: filter } });
    return data.Items?.[0] || null;
  }

  async createCustomer(payload) {
    const { data } = await this.http.post('/Contact/Customer', payload);
    return data;
  }

  async updateCustomer(uid, payload, rowVersion) {
    const { data } = await this.http.put(`/Contact/Customer/${uid}`, payload, {
      headers: rowVersion ? { 'If-Match': rowVersion } : {},
    });
    return data;
  }

  // Upsert a MYOB customer into the local customers table.
  // Returns { action: 'created'|'updated'|'skipped' }
  async syncCustomerToLocal(mc) {
    const db = this._getDb();
    const name  = mc.CompanyName || `${mc.FirstName || ''} ${mc.LastName || ''}`.trim();
    const addr  = mc.Addresses?.[0] || {};
    const email = addr.Email || null;
    const phone = addr.Phone1 || null;
    const existing = await db
      .prepare('SELECT id FROM customers WHERE myob_customer_uid = ?')
      .get(mc.UID);

    if (existing) {
      await db
        .prepare(
          `UPDATE customers SET name = ?, email = COALESCE(email, ?), phone = COALESCE(phone, ?),
           address_street = COALESCE(address_street, ?), address_city = COALESCE(address_city, ?),
           address_state = COALESCE(address_state, ?), address_postcode = COALESCE(address_postcode, ?),
           myob_synced_at = now_utc_text(), updated_at = now_utc_text()
           WHERE myob_customer_uid = ?`
        )
        .run(name, email, phone, addr.Street || null, addr.City || null, addr.State || null, addr.PostCode || null, mc.UID);
      return { action: 'updated' };
    }

    // Try to match by name before creating a new record
    const byName = await db.prepare('SELECT id FROM customers WHERE LOWER(name) = LOWER(?)').get(name);
    if (byName) {
      await db
        .prepare('UPDATE customers SET myob_customer_uid = ?, myob_synced_at = now_utc_text(), updated_at = now_utc_text() WHERE id = ?')
        .run(mc.UID, byName.id);
      return { action: 'updated' };
    }

    await db
      .prepare(
        `INSERT INTO customers (name, email, phone, address_street, address_city, address_state, address_postcode, myob_customer_uid, myob_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, now_utc_text())`
      )
      .run(name, email, phone, addr.Street || null, addr.City || null, addr.State || null, addr.PostCode || null, mc.UID);
    return { action: 'created' };
  }

  // ── Invoices ──────────────────────────────────────────────────────────────

  // Ensure the customer exists in MYOB and return their UID.
  async ensureCustomerInMyob(customer) {
    if (customer.myob_customer_uid) return customer.myob_customer_uid;

    const existing = await this.findCustomerByName(customer.name);
    if (existing) {
      const db = this._getDb();
      await db
        .prepare('UPDATE customers SET myob_customer_uid = ?, updated_at = now_utc_text() WHERE id = ?')
        .run(existing.UID, customer.id);
      return existing.UID;
    }

    const addr = {
      Location: 1,
      Street:   customer.address_street || '',
      City:     customer.address_city   || '',
      State:    customer.address_state  || '',
      PostCode: customer.address_postcode || '',
      Country:  customer.address_country || 'Australia',
      Email:    customer.email || '',
      Phone1:   customer.phone || '',
    };
    const payload = customer.contact_name
      ? { FirstName: customer.contact_name, LastName: customer.name, IsIndividual: true, Addresses: [addr] }
      : { CompanyName: customer.name, IsIndividual: false, Addresses: [addr] };

    const result = await this.createCustomer(payload);
    const newUid = result.UID || result.uid;
    const db = this._getDb();
    await db
      .prepare('UPDATE customers SET myob_customer_uid = ?, updated_at = now_utc_text() WHERE id = ?')
      .run(newUid, customer.id);
    return newUid;
  }

  // Push a local invoice to MYOB. sendEmail=true triggers MYOB to email it.
  // Returns the MYOB invoice UID.
  async pushInvoice({ invoice, customer, items, sendEmail = false }) {
    const customerUid = await this.ensureCustomerInMyob(customer);

    const lines = items.map((item) => ({
      Description: item.description,
      Quantity:    item.quantity,
      UnitPrice:   item.unit_price,
      Account:     myob.defaultIncomeAccountUid ? { UID: myob.defaultIncomeAccountUid } : undefined,
      TaxCode:     myob.defaultTaxCodeUid        ? { UID: myob.defaultTaxCodeUid }        : undefined,
    }));

    const payload = {
      Date:                   invoice.issue_date + 'T00:00:00',
      Customer:               { UID: customerUid },
      Number:                 invoice.invoice_number,
      InvoiceType:            'Service',
      IsTaxInclusive:         false,
      Lines:                  lines,
      Comment:                invoice.notes || '',
      InvoiceDeliveryStatus:  sendEmail ? 'Email' : 'AlreadyPrintedOrSent',
    };

    if (invoice.due_date) {
      payload.Terms = { PaymentIsDue: 'DayOfMonthAfterEOM', BalanceDueDate: parseInt(invoice.due_date.slice(8), 10) };
    }

    const { data } = await this.http.post('/Sale/Invoice/Service', payload);
    return data.UID || data.uid;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async isConnected() {
    try {
      const db = this._getDb();
      const stored = await db.prepare('SELECT refresh_token FROM myob_tokens LIMIT 1').get();
      return !!(stored?.refresh_token || myob.refreshToken);
    } catch {
      return false;
    }
  }
}

module.exports = new MyobClient();
