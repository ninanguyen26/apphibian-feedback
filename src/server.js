require('dotenv').config({ quiet: true });
const { createApp, readConfig } = require('./app');

const config = readConfig();
if (!config.apiKey || !config.from) {
  throw new Error('Set RESEND_API_KEY and FEEDBACK_EMAIL_FROM before starting.');
}
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
const server = createApp({ config }).listen(port, '0.0.0.0', () => {
  console.log(`Apphibian feedback listening on port ${port}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
