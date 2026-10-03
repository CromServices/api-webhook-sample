# API webhook sample · Crom Services

A scoped Express webhook receiver: `POST /webhook` checks an HMAC-SHA256 signature over the raw body and replies 200 or 401.

<!-- Built on CromServices/crom-ts-api-starter at b2cd23a (package.json "starter.config"). Shared files come from the starter; do not edit them here first. -->

## What it is

A public sample of how Crom Services approaches small API and webhook work. It is for illustration only, not a client system, and it holds no real data. The only secret is the published demo value `crom-demo-webhook-secret-v1`.

- `GET /` serves a short landing page on the shared Crom theme.
- `GET /health` returns `{"ok":true}`.
- `POST /webhook` verifies the `X-Signature-256` header (raw hex, or `sha256=<hex>`) against an HMAC-SHA256 of the raw JSON body. A match returns `200 {"received":true}`; a missing or wrong signature, or an empty secret, returns `401` (fail-closed).

| Path | Purpose |
|---|---|
| `src/verify.ts` | Sign and verify helpers (timing-safe compare) |
| `src/app.ts` | `createApp()`: `GET /`, `GET /health`, `POST /webhook` with raw-body capture |
| `src/landing.ts` | Landing page HTML (pinned crom-shared theme and footer) |
| `src/config.ts` | Reads `starter.config` from `package.json` (from the starter) |
| `src/server.ts` | Listen entry (`PORT`, `HOST`, `WEBHOOK_SECRET`) |
| `test/` | `node:test` suites (verify, HTTP, landing page) |
| `docs/` | GitHub Pages walkthrough with copy-paste curl against the live demo |
| `Dockerfile`, `fly.toml` | Disposable demo host (`crom-api-webhook-demo`, `syd`) |

## What it proves

- One HMAC-verified webhook endpoint, done the careful way: signature over the raw body, timing-safe compare, fail-closed on anything missing.
- The same toolchain as every Crom Services TypeScript API: strict TypeScript, `node:test`, a multi-stage `Dockerfile` and `fly.toml`.

Does not prove: payment flows, retries or a production queue.

## Live link

- Demo: https://crom-api-webhook-demo.fly.dev
- Health: https://crom-api-webhook-demo.fly.dev/health
- Docs (curl and the published demo secret): https://cromservices.github.io/api-webhook-sample/

```bash
curl -sS https://crom-api-webhook-demo.fly.dev/health
# {"ok":true}
```

## Run in 3 commands

Needs Node 20 or newer.

```bash
npm install
npm test
npm run dev        # http://localhost:3000/
```

`npm run build` compiles to `dist/`, and `npm start` runs the compiled server. `PORT` defaults to 3000; `WEBHOOK_SECRET` defaults to the published demo value.

Deploy: a push to `main` runs `.github/workflows/fly.yml`, which deploys to Fly when the `FLY_API_TOKEN` repository secret is set (and skips cleanly when it is not). `docs/` is published by `.github/workflows/pages.yml`.

## Reuse for a new job

1. **Start from the template**: use [CromServices/crom-ts-api-starter](https://github.com/CromServices/crom-ts-api-starter) and set `starter.config.ref` in `package.json` to the starter commit you started from.
2. **Bring the webhook code**: copy `src/verify.ts` and the `/webhook` route from `src/app.ts`, and set the signature header name and secret source for the job's sender.
3. **Set the app name** in `fly.toml` and keep secrets in `fly secrets set WEBHOOK_SECRET=...`, never in the repo.
4. **Deploy** and put the URL under **Live link**.

## Footer

---

Crom Services · Australia · cromservices@gmail.com
Site: https://cromservices.com.au · Packs: https://cromservices.github.io/job-page-sample/packs/

<a href="https://cromservices.com.au"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cromservices.com.au/brand/credit/crom-credit-lockup-dark@2x.png"><img src="https://cromservices.com.au/brand/credit/crom-credit-lockup-light@2x.png" width="175" height="20" alt="Built by Crom Services"></picture></a>

MIT, see LICENSE.
