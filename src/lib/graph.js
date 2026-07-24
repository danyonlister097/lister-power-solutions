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

async function getUnreadSupplierEmails() {
  const mailbox = config.graph.mailbox;
  const filter = encodeURIComponent(
    `from/emailAddress/address eq 'ipswich@cnw.com.au' and isRead eq false and hasAttachments eq true`
  );
  const data = await graphGet(
    `/users/${mailbox}/messages?$filter=${filter}&$select=id,subject,from,receivedDateTime&$top=20`
  );
  return data.value || [];
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
