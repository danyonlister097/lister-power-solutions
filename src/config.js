require('dotenv').config();

function required(name, value) {
  if (!value) {
    console.warn(`[config] Warning: ${name} is not set in your .env file.`);
  }
  return value;
}

const myobEnabled = String(process.env.MYOB_ENABLED).toLowerCase() === 'true';

module.exports = {
  app: {
    port: Number(process.env.PORT || 3000),
    sessionSecret: required('SESSION_SECRET', process.env.SESSION_SECRET),
    cronSecret: process.env.CRON_SECRET || '',
  },
  db: {
    connectionString: required('DATABASE_URL', process.env.DATABASE_URL),
  },
  blob: {
    token: required('BLOB_READ_WRITE_TOKEN', process.env.BLOB_READ_WRITE_TOKEN),
  },
  admin: {
    name: process.env.ADMIN_NAME || 'Admin',
    email: process.env.ADMIN_EMAIL || '',
    password: process.env.ADMIN_PASSWORD || '',
  },
  email: {
    // Resend (resend.com) API key. Left blank, sendEmail() logs instead of
    // sending - the app keeps working in dev/before this is configured.
    apiKey: process.env.RESEND_API_KEY || '',
    from: process.env.EMAIL_FROM || 'Lister Power Solutions <admin@listerpowersolutions.com.au>',
    // Used to build absolute links in email bodies (password reset, etc.) -
    // req.protocol/host aren't available outside a request, and Vercel's
    // production URL isn't known at require-time either. Set this to the
    // real domain once the app is deployed.
    appUrl: process.env.APP_URL || 'http://localhost:3000',
  },
  myob: {
    enabled: myobEnabled,
    clientId: myobEnabled ? required('MYOB_CLIENT_ID', process.env.MYOB_CLIENT_ID) : process.env.MYOB_CLIENT_ID,
    clientSecret: myobEnabled ? required('MYOB_CLIENT_SECRET', process.env.MYOB_CLIENT_SECRET) : process.env.MYOB_CLIENT_SECRET,
    redirectUri: process.env.MYOB_REDIRECT_URI || 'http://localhost:3000/oauth/callback',
    refreshToken: myobEnabled ? required('MYOB_REFRESH_TOKEN', process.env.MYOB_REFRESH_TOKEN) : process.env.MYOB_REFRESH_TOKEN,
    companyFileId: myobEnabled ? required('MYOB_COMPANY_FILE_ID', process.env.MYOB_COMPANY_FILE_ID) : process.env.MYOB_COMPANY_FILE_ID,
    companyFileUsername: process.env.MYOB_COMPANY_FILE_USERNAME || '',
    companyFilePassword: process.env.MYOB_COMPANY_FILE_PASSWORD || '',
    baseUrl: process.env.MYOB_API_BASE_URL || 'https://api.myob.com/accountright',
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};
