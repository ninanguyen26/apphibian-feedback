# Apphibian Feedback

Independent feedback delivery for Apphibian apps. The app sends a message and optional JPEG photos here; this service emails them through Resend to **feedback@apphibian.app**. It has no dependency on Ledge, no player accounts, and no database. Gameplay and drafts stay in each app.

## Local setup

Requires Node.js 22 or later.

1. Run `npm ci`.
2. Copy `.env.example` to `.env`.
3. Set `RESEND_API_KEY` and `FEEDBACK_EMAIL_FROM` to a sender on your verified Resend domain. Secrets belong only in this server's environment.
4. Run `npm start`. Default port: 3000.
5. Run `npm test` for HTTP tests with mocked delivery; tests send no real email.

## API

`GET /health` returns `{ "status": "ok" }`. Health checks do not send mail or use feedback rate limits.

`POST /feedback`, with `Content-Type: application/json`:

```json
{
  "appId": "librarian",
  "submissionId": "unique_saved_draft_123456",
  "message": "Describe the issue or idea here.",
  "appVersion": "0.1.0",
  "device": "ios 27",
  "photos": []
}
```

- `appId` must be configured in `FEEDBACK_APPS`. To add another app, update that JSON map, for example `{"librarian":"Librarian","glean":"Glean"}`. The server creates subjects such as “Librarian feedback”.
- `submissionId`: 16–80 letters, digits, underscores, or hyphens. Keep it unchanged for retries; generate a new ID when the draft is edited.
- `message`: nonblank, at most 5,000 characters. `appVersion`: nonblank, up to 40 characters. `device`: nonblank, up to 100 characters.
- `photos`: optional array of up to three `{ "content": "<JPEG base64>" }` objects, each at most 2 MiB decoded. Clients should resize/re-encode photos to JPEG before attaching. No remote URLs or client filenames are accepted. Request body cap: 9 MiB.
- Success: HTTP 200 `{ "sent": true }`, after Resend confirms acceptance. This is provider acceptance, not a guarantee that the recipient inbox has delivered the email.
- Failure: JSON `{ "error": "…" }`, with 400 for invalid input, 413 for an oversized body, 429 for rate limiting, 503 for missing delivery config, or 502 for provider/network failure. Apps must preserve their draft and photos until success. The server stores no drafts.
- Unchanged retries use the same Resend idempotency key, which Resend retains for 24 hours. A retry after that window can deliver again.

This is an anonymous endpoint for mobile apps. App IDs identify submissions but do not authenticate a caller. Recipient, sender, and subject are server-controlled. Do not embed the Resend key or a supposed shared secret in a mobile app. Browser clients would need a separately configured CORS policy; native apps do not.

## Render

`render.yaml` defines a standalone free Node web service, with `npm ci`, `npm start`, and `/health`. After publishing this repository to your Git host, create a Render Blueprint from it and supply the existing Resend account's API key and verified sender when prompted.

Configure `FEEDBACK_APPS` for the apps that may submit. Optional rate settings default to **5 requests/hour per IP across apps** and **100 requests/day per running instance**. Limits are in memory, reset on restart, and aren't shared across instances. Start with one instance.

For the requested keep-alive approach, configure cron-job.org to GET `https://<your-service-host>/health` every five minutes. Free Render services have shared monthly running-hour limits and may still restart. The server contacts Resend over HTTPS, not SMTP. Do not store attachments or SQLite databases on Render's ephemeral filesystem.

## Current status

Repository: https://github.com/ninanguyen26/apphibian-feedback. No Render deployment, keep-alive job, or real-email verification has been created. Existing apps have not been repointed. Librarian currently uses the earlier Ledge URL and will need its feedback URL and payload updated to this service's URL and `appId` after deployment. The earlier Ledge feedback code is not part of this project and has not been removed.
