const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const RECIPIENT = 'feedback@apphibian.app';
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const INVALID_INPUT = 'Add a message (up to 5,000 characters) and at most three JPEG photos, 2 MB each.';

function positiveInteger(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Feedback limits must be positive integers.');
  return parsed;
}

function readConfig(env = process.env) {
  const apps = JSON.parse(env.FEEDBACK_APPS || '{"librarian":"Librarian"}');
  if (!apps || Array.isArray(apps) || typeof apps !== 'object' || Object.keys(apps).length === 0) {
    throw new Error('FEEDBACK_APPS must be a nonempty JSON object of app IDs and display names.');
  }
  for (const [id, name] of Object.entries(apps)) {
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(id) || typeof name !== 'string' || !name.trim() || name.length > 40 || /[\r\n]/.test(name)) {
      throw new Error('FEEDBACK_APPS contains an invalid app ID or display name.');
    }
  }
  return {
    apps,
    apiKey: env.RESEND_API_KEY?.trim() || '',
    from: env.FEEDBACK_EMAIL_FROM?.trim() || '',
    ipHourlyLimit: positiveInteger(env.FEEDBACK_IP_HOURLY_LIMIT, 5),
    dailyLimit: positiveInteger(env.FEEDBACK_DAILY_LIMIT, 100),
  };
}

function invalid(message = INVALID_INPUT) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

// Accept inline images only. Never fetch client URLs or accept client recipients/senders.
function validateFeedback(body, apps) {
  if (!body || Array.isArray(body) || typeof body !== 'object') invalid();
  if (typeof body.appId !== 'string' || !Object.hasOwn(apps, body.appId)) invalid('Unknown app.');
  if (typeof body.submissionId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(body.submissionId)) invalid('Invalid submission ID.');
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 5000) invalid();
  for (const [key, limit] of [['appVersion', 40], ['device', 100]]) {
    if (typeof body[key] !== 'string' || !body[key].trim() || body[key].length > limit || /[\r\n]/.test(body[key])) invalid('Invalid app or device version.');
  }
  const photos = body.photos ?? [];
  if (!Array.isArray(photos) || photos.length > 3) invalid();
  const attachments = photos.map((photo, index) => {
    const content = photo?.content;
    if (typeof content !== 'string' || content.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) invalid();
    const bytes = Buffer.from(content, 'base64');
    if (bytes.length < 5 || bytes.length > MAX_PHOTO_BYTES ||
        !bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
        !bytes.subarray(-2).equals(Buffer.from([255, 217])) || bytes.toString('base64') !== content) invalid();
    return { filename: `photo-${index + 1}.jpg`, content };
  });
  return {
    appId: body.appId,
    appName: apps[body.appId],
    submissionId: body.submissionId,
    message: body.message.trim(),
    appVersion: body.appVersion,
    device: body.device,
    attachments,
  };
}

function createApp({ config = readConfig(), fetchImpl = fetch } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Render sits behind one trusted reverse proxy. Limits use the resolved client IP.
  app.set('trust proxy', 1);
  app.use(helmet());
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.post('/feedback',
    // Cheap limits run before decoding photo payloads. Health pings do not consume them.
    rateLimit({
      windowMs: 24 * 60 * 60 * 1000,
      limit: config.dailyLimit,
      keyGenerator: () => 'all-feedback',
      standardHeaders: 'draft-8', legacyHeaders: false,
      message: { error: 'Feedback is busy. Please try later; keep your draft.' },
    }),
    rateLimit({
      windowMs: 60 * 60 * 1000,
      limit: config.ipHourlyLimit,
      standardHeaders: 'draft-8', legacyHeaders: false,
      message: { error: 'Please wait before sending more feedback; keep your draft.' },
    }),
    express.json({ limit: '9mb', strict: true }),
    async (req, res) => {
      try {
        const feedback = validateFeedback(req.body, config.apps);
        if (!config.apiKey || !config.from) {
          return res.status(503).json({ error: 'Feedback delivery is unavailable. Please keep your draft and try later.' });
        }
        // Resend deduplicates unchanged retries using the same key (24-hour retention).
        const digest = crypto.createHash('sha256').update(JSON.stringify(feedback)).digest('hex');
        const response = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST', signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': `apphibian-feedback-${digest}`,
          },
          body: JSON.stringify({
            from: config.from,
            to: [RECIPIENT],
            subject: `${feedback.appName} feedback`,
            text: `${feedback.message}\n\n---\nApp: ${feedback.appName} ${feedback.appVersion}\nDevice: ${feedback.device}\nReference: ${feedback.submissionId}`,
            attachments: feedback.attachments,
          }),
        });
        if (!response.ok || !(await response.json())?.id) {
          return res.status(502).json({ error: 'Could not confirm sending. Please keep your draft and try again.' });
        }
        return res.json({ sent: true });
      } catch (error) {
        return res.status(error.statusCode === 400 ? 400 : 502).json({
          error: error.statusCode === 400 ? error.message : 'Could not send feedback. Please keep your draft and try again.',
        });
      }
    });
  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, req, res, next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Photos are too large.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    // Do not return or log feedback text, images, secrets, or upstream responses.
    return res.status(500).json({ error: 'Feedback is unavailable. Please keep your draft.' });
  });
  return app;
}

module.exports = { createApp, readConfig, validateFeedback };
