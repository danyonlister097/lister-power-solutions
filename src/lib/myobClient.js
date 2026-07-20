const axios = require('axios');
const { myob } = require('../config');
const logger = require('./logger');

/**
 * Thin wrapper around the MYOB AccountRight API (via the MYOB Developer / Cloud API).
 * Docs: https://developer.myob.com/api/accountright/v2/
 *
 * MYOB requires:
 *  - OAuth2 Bearer token (refreshed via refresh_token grant)
 *  - x-myobapi-key header (your app's Client ID)
 *  - x-myobapi-version header
 *  - Basic auth header for the *company file* itself (its own username/password),
 *    separate from the OAuth2 user token.
 */
class MyobClient {
  constructor() {
    this.accessToken = null;
    this.tokenExpiresAt = 0;

    this.http = axios.create({
      baseURL: `${myob.baseUrl}/${myob.companyFileId}`,
      timeout: 20000,
    });

    this.http.interceptors.request.use(async (cfg) => {
      const token = await this.getAccessToken();
      cfg.headers.Authorization = `Bearer ${token}`;
      cfg.headers['x-myobapi-key'] = myob.clientId;
      cfg.headers['x-myobapi-version'] = 'v2';
      if (myob.companyFileUsername) {
        const cfAuth = Buffer.from(
          `${myob.companyFileUsername}:${myob.companyFilePassword}`
        ).toString('base64');
        cfg.headers['x-myobapi-cftoken'] = cfAuth;
      }
      cfg.headers.Accept = 'application/json';
      cfg.headers['Content-Type'] = 'application/json';
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

  async getAccessToken() {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }

    const params = new URLSearchParams({
      client_id: myob.clientId,
      client_secret: myob.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: myob.refreshToken,
    });

    const { data } = await axios.post(
      'https://secure.myob.com/oauth2/v1/authorize/token',
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;

    // NOTE: MYOB rotates refresh tokens on each use in some app configurations.
    // If yours does, persist data.refresh_token back to your secret store here,
    // e.g. update process.env / a database / a vault - not left as a TODO in prod.
    if (data.refresh_token && data.refresh_token !== myob.refreshToken) {
      logger.warn('MYOB issued a new refresh_token - update MYOB_REFRESH_TOKEN in your secret store.');
    }

    return this.accessToken;
  }

  async findCustomerByName(name) {
    const filter = `Name eq '${name.replace(/'/g, "''")}'`;
    const { data } = await this.http.get('/Contact/Customer', { params: { $filter: filter } });
    return data.Items && data.Items[0];
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

  async createInvoice(payload) {
    const { data } = await this.http.post('/Sale/Invoice/Service', payload);
    return data;
  }

  async findInvoiceByCustomerPO(poNumber) {
    const filter = `CustomerPurchaseOrderNumber eq '${poNumber.replace(/'/g, "''")}'`;
    const { data } = await this.http.get('/Sale/Invoice/Service', { params: { $filter: filter } });
    return data.Items && data.Items[0];
  }
}

module.exports = new MyobClient();
