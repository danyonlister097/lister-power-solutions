const app = require('./app');
const config = require('./config');
const logger = require('./lib/logger');
const db = require('./db');

db.ready()
  .then(() => {
    app.listen(config.app.port, () => {
      logger.info(`Server listening on http://localhost:${config.app.port}`);
    });
  })
  .catch((err) => {
    logger.error('Failed to initialize database', { error: err.message, stack: err.stack });
    process.exit(1);
  });
