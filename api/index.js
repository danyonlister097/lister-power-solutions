const app = require('../src/app');
const db = require('../src/db');

// Every cold start needs the schema/seed bootstrap done before the first
// request is handled; db.ready resolves once and is an instant no-op on
// every later (warm) invocation.
module.exports = async (req, res) => {
  await db.ready;
  app(req, res);
};
