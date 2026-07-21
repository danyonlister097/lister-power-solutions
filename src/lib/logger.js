const winston = require('winston');
const path = require('path');

const transports = [
  new winston.transports.Console({
    format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
  }),
];

// Vercel's serverless filesystem is read-only outside /tmp, and console
// output is already captured as Runtime Logs there - file transports would
// just crash the process on boot (mkdirSync fails), so they're local-dev-only.
if (!process.env.VERCEL) {
  transports.push(
    new winston.transports.File({ filename: path.join('logs', 'app-error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join('logs', 'app.log') })
  );
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports,
});

module.exports = logger;
