const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, readConfig } = require('../src/app');

const photo = Buffer.from([255, 216, 255, 224, 0, 16, 255, 217]).toString('base64');
const sample = () => ({ appId: 'librarian', submissionId: 'feedback_test_123456', message: 'A hint is hard to read.', appVersion: '0.1.0', device: 'ios 27', photos: [{ content: photo }] });
const config = (extra = {}) => ({ apps: { librarian: 'Librarian', glean: 'Glean' }, apiKey: 'test-only', from: 'support@apphibian.app', ipHourlyLimit: 50, dailyLimit: 100, ...extra });
async function serve(t, options = {}) {
  const calls = [];
  const app = createApp({ config: config(options.config), fetchImpl: options.fetchImpl || (async (url, request) => {
    calls.push({ url, ...request }); return { ok: true, json: async () => ({ id: 'mock-email' }) };
  }) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { calls, get: path => fetch(base + path), post: body => fetch(base + '/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }) };
}

test('shared endpoint routes known apps to the fixed inbox with JPEG attachments', async t => {
  const { post, calls } = await serve(t);
  for (const appId of ['librarian', 'glean']) {
    const response = await post({ ...sample(), appId, to: 'other@example.com', from: 'other@example.com' });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { sent: true });
  }
  const librarian = JSON.parse(calls[0].body), glean = JSON.parse(calls[1].body);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(librarian.subject, 'Librarian feedback'); assert.equal(glean.subject, 'Glean feedback');
  assert.deepEqual(librarian.to, ['feedback@apphibian.app']); assert.equal(librarian.from, 'support@apphibian.app');
  assert.equal(librarian.attachments[0].content, photo); assert.equal(librarian.attachments[0].filename, 'photo-1.jpg');
  assert(librarian.text.includes('ios 27')); assert(librarian.text.includes(sample().message));
  assert.notEqual(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
});
test('unchanged retries share a provider key; edits and new submissions do not', async t => {
  const { post, calls } = await serve(t);
  const body = sample(); await post(body); await post(body);
  await post({ ...body, message: 'Changed message' });
  await post({ ...body, submissionId: 'new_submission_123456' });
  const keys = calls.map(call => call.headers['Idempotency-Key']);
  assert.equal(keys[0], keys[1]); assert.notEqual(keys[0], keys[2]); assert.notEqual(keys[0], keys[3]);
});
test('invalid input, forged apps, and non-JPEG or oversize attachments never reach Resend', async t => {
  const { post, calls } = await serve(t);
  for (const change of [
    { appId: 'unknown' }, { appId: '__proto__' }, { message: ' ' }, { message: 'x'.repeat(5001) },
    { submissionId: 'short' }, { device: 'x'.repeat(101) }, { appVersion: 'bad\nversion' },
    { photos: Array(4).fill({ content: photo }) }, { photos: [{ content: 'https://example.com/photo.jpg' }] },
    { photos: [{ content: 'this-is-not-base64' }] }, { photos: [{ content: Buffer.from('not JPEG').toString('base64') }] },
    { photos: [{ content: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }] },
  ]) assert.equal((await post({ ...sample(), ...change })).status, 400);
  assert.equal((await post('{ broken')).status, 400);
  assert.equal((await post({ ...sample(), message: 'x'.repeat(10 * 1024 * 1024) })).status, 413);
  assert.equal(calls.length, 0);
});
test('text-only submissions work without a photos field', async t => {
  const { post, calls } = await serve(t); const body = sample(); delete body.photos;
  assert.equal((await post(body)).status, 200); assert.deepEqual(JSON.parse(calls[0].body).attachments, []);
});
test('provider failure or uncertain confirmation never returns success', async t => {
  for (const fetchImpl of [async () => ({ ok: false }), async () => { throw Error('network failure'); }, async () => ({ ok: true, json: async () => ({}) })]) {
    const { post } = await serve(t, { fetchImpl });
    const response = await post(sample()); assert.equal(response.status, 502); assert.notEqual((await response.json()).sent, true);
  }
});
test('missing provider configuration refuses delivery without exposing credentials', async t => {
  const { post, calls } = await serve(t, { config: { apiKey: '' } });
  const response = await post(sample()); assert.equal(response.status, 503); assert.equal(calls.length, 0);
  assert(!JSON.stringify(await response.json()).includes('test-only'));
});
test('health checks bypass send limits; per-IP limit applies across apps', async t => {
  const { get, post, calls } = await serve(t, { config: { ipHourlyLimit: 1 } });
  assert.equal((await post(sample())).status, 200);
  assert.equal((await post({ ...sample(), appId: 'glean' })).status, 429);
  for (let i = 0; i < 4; i++) assert.equal((await get('/health')).status, 200);
  assert.equal((await get('/unknown')).status, 404); assert.equal(calls.length, 1);
});
test('global daily cap applies independently of the per-IP cap', async t => {
  const { post, calls } = await serve(t, { config: { dailyLimit: 1, ipHourlyLimit: 10 } });
  assert.equal((await post(sample())).status, 200); assert.equal((await post(sample())).status, 429); assert.equal(calls.length, 1);
});
test('configuration supports adding apps and rejects invalid limits and names', () => {
  const result = readConfig({ FEEDBACK_APPS: '{"librarian":"Librarian","glean":"Glean"}', FEEDBACK_IP_HOURLY_LIMIT: '8' });
  assert.equal(result.apps.glean, 'Glean'); assert.equal(result.ipHourlyLimit, 8);
  for (const env of [{ FEEDBACK_APPS: '[]' }, { FEEDBACK_APPS: '{}' }, { FEEDBACK_APPS: '{"Bad ID":"Bad"}' }, { FEEDBACK_IP_HOURLY_LIMIT: 'no' }, { FEEDBACK_DAILY_LIMIT: '-1' }]) assert.throws(() => readConfig(env));
});
