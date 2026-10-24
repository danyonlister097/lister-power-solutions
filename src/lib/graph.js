const axios = require('axios');
const config = require('../config');

let _token = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  if (_token && Date.now() < _tokenExpiry - 60000) return _token;

  const res = await axios.post(
    `https://login.microsoftonline.com/${config.graph.tenantId}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: config.graph.clientId,
      client_secret: config.graph.clientSecret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  _token = res.data.access_token;
  _tokenExpiry = Date.now() + res.data.expires_in * 1000;
  return _token;
}

async function graphGet(path) {
  const token = await getAccessToken();
  const res = await axios.get(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data;
}

async function graphPatch(path, body) {
  const token = await getAccessToken();
  await axios.patch(`https://graph.microsoft.com/v1.0${path}`, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

// Any address at cnw.com.au can send an invoice or credit note - branch
// mailboxes (ipswich@, enoggera@, ...) and individual sales reps
// (brodie@cnw.com.au etc.) alike. That match happens here in JS rather than
// in the Graph $filter: endswith()/contains() on from/emailAddress/address
// is widely reported as unsupported by the /messages filter (it only
// reliably supports eq on that property), so a domain-suffix match can't be
// expressed server-side. Pages through every unread message with an
// attachment (not just the first page) so a busy shared mailbox can't bury
// a CNW email before it's ever checked - the content parser
// (parseCnwDocument) is still what actually decides whether a given PDF is
// an invoice/credit note, so widening this match doesn't risk misreading
// some other sender's PDF as one.
const CNW_DOMAIN = '@cnw.com.au';

async function getUnreadSupplierEmails() {
  const mailbox = config.graph.mailbox;
  const filter = encodeURIComponent('isRead eq false and hasAttachments eq true');
  let path = `/users/${mailbox}/messages?$filter=${filter}&$select=id,subject,from,receivedDateTime&$top=999`;
  const matches = [];
  while (path) {
    const data = await graphGet(path);
    for (const m of data.value || []) {
      const address = ((m.from && m.from.emailAddress && m.from.emailAddress.address) || '').toLowerCase();
      if (address.endsWith(CNW_DOMAIN)) matches.push(m);
    }
    // @odata.nextLink is a full URL; graphGet only takes a path.
    const next = data['@odata.nextLink'];
    path = next ? next.replace('https://graph.microsoft.com/v1.0', '') : null;
  }
  return matches;
}

async function getEmailAttachments(messageId) {
  const mailbox = config.graph.mailbox;
  const data = await graphGet(`/users/${mailbox}/messages/${messageId}/attachments`);
  return data.value || [];
}

async function markAsRead(messageId) {
  await graphPatch(`/users/${config.graph.mailbox}/messages/${messageId}`, { isRead: true });
}

module.exports = { getUnreadSupplierEmails, getEmailAttachments, markAsRead };
