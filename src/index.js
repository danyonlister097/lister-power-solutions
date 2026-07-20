const app = require('./app');
const config = require('./config');
const logger = require('./lib/logger');

app.listen(config.app.port, () => {
  logger.info(`Server listening on http://localhost:${config.app.port}`);
});
