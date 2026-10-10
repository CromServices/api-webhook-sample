# API webhook sample · Crom Services

A scoped Express webhook receiver: `POST /webhook` checks an HMAC-SHA256 signature over the raw body and replies 200 or 401.

<!-- Built on CromServices/crom-ts-api-starter at b2cd23a (package.json "starter.config"). Shared files come from the starter; do not edit them here first. -->

## What it is

A public sample of how Crom Services approaches small API and webhook work. It is for illustration only, not a client system. The only published secret is the demo value `crom-demo-webhook-secret-v1`. A second value, `DEMO_ADMIN_TOKEN`, unlocks private controls and is never shown on the public pages. Leave it unset and those controls stay closed.

The public pages are a small shop and a stock count. Placing an order sends it, over HTTP, through the same signed `POST /webhook` check. The pages stay in plain language (order numbers, human times, on-hand counts). Labels live in `src/story.ts`.

- `GET /` shows the online shop and stock from the stored file.
- `GET /shop` places an order. `GET /stock` is the stock count. `GET /history` is what happened, in plain language.
- `GET /demo` reads the saved before-run and after-run from the same file. `GET /demo?view=triage` is that before-run counted up: what was checked, what was found, what was fixed first, and what was left for later. The page title is the only place that says sample.
- `GET /health` returns `{"ok":true}`.
- `POST /webhook` verifies the `X-Signature-256` header (raw hex, or `sha256=<hex>`) against an HMAC-SHA256 of the raw JSON body. A non-order body such as `{"event":"ping"}` still returns `200 {"received":true}` when the signature matches, and `401 {"error":"invalid signature"}` when it does not. An order-shaped body is stocked. The check runs before anything is stored.

| Path | Purpose |
|---|---|
| `src/verify.ts` | Sign and verify helpers (timing-safe compare) |
| `src/app.ts` | `createApp()`: public pages, `GET /health`, `POST /webhook`, private controls |
| `src/store.ts` | Shop orders, stock rows, attempt history, and the two saved runs |
| `src/deliver.ts` | Sends an order to `/webhook` and tries again until it lands |
| `src/present.ts` | Turns stored rows into the words on the pages |
| `src/pages.ts` | Page HTML |
| `src/story.ts` | Customer-facing labels |
| `src/landing.ts` | Shared crom-shared v1.0.2 header and footer, pinned |
| `src/server.ts` | Listen entry (`PORT`, `HOST`, `WEBHOOK_SECRET`, `DATA_PATH`, `DEMO_ADMIN_TOKEN`) |
| `test/` | `node:test` suites |
| `docs/` | GitHub Pages page (the earlier static copy; the live demo is the Fly app) |
| `Dockerfile`, `fly.toml` | Disposable demo host (`crom-api-webhook-demo`, `syd`) |

## What it proves

- One HMAC-verified webhook endpoint, done the careful way: signature over the raw body, timing-safe compare, fail-closed on anything missing.
- A real shop-to-stock send on that same check: a slow first reply can land twice on the old path, a failed check can disappear on the old path, and the fixed path keeps one stock row, tries again while stock is down, and notes a failed check.
- The same toolchain as every Crom Services TypeScript API: strict TypeScript, `node:test`, a multi-stage `Dockerfile` and `fly.toml`.

Does not prove: payment flows or a production queue.

## Live link

- Demo: https://crom-api-webhook-demo.fly.dev
- Health: https://crom-api-webhook-demo.fly.dev/health
- Owner page (plain language): https://cromservices.github.io/api-webhook-sample/

```bash
curl -sS https://crom-api-webhook-demo.fly.dev/health
# {"ok":true}
```

### Try it with curl

The published demo secret is `crom-demo-webhook-secret-v1` (a public sample value, never a client secret). The signature is HMAC-SHA256 over the **raw** JSON body, sent in `X-Signature-256` as hex or `sha256=<hex>`.

Valid signature for the fixed body `{"event":"ping"}`:

```bash
curl -sS -X POST https://crom-api-webhook-demo.fly.dev/webhook \
  -H 'content-type: application/json' \
  -H 'x-signature-256: sha256=2f95da3b8a47b656b7e8a980a32916dce258b449cf738632c5ffac988b6f3e9c' \
  --data '{"event":"ping"}'
# {"received":true}
```

Compute the same hex yourself:

```bash
printf '%s' '{"event":"ping"}' \
  | openssl dgst -sha256 -hmac 'crom-demo-webhook-secret-v1' -hex \
  | awk '{print $NF}'
```

Fail-closed, missing or bad signature:

```bash
curl -sS -o /dev/stderr -w '%{http_code}\n' -X POST https://crom-api-webhook-demo.fly.dev/webhook \
  -H 'content-type: application/json' --data '{"event":"ping"}'
# {"error":"invalid signature"}
# 401

curl -sS -o /dev/stderr -w '%{http_code}\n' -X POST https://crom-api-webhook-demo.fly.dev/webhook \
  -H 'content-type: application/json' \
  -H 'x-signature-256: sha256=0000000000000000000000000000000000000000000000000000000000000000' \
  --data '{"event":"ping"}'
# {"error":"invalid signature"}
# 401
```

## Run in 3 commands

Needs Node 20 or newer.

```bash
npm install
npm test
npm run dev        # http://localhost:3000/
```

`npm run build` compiles to `dist/`, and `npm start` runs the compiled server. `PORT` defaults to 3000; `WEBHOOK_SECRET` defaults to the published demo value. Orders and stock are stored in `DATA_PATH` (default `data/demo-shop.json`). On Fly that file lives on one machine's disk (`flyctl scale count 1`); auto-stop keeps the disk, and a new deploy starts empty. Do not attach a volume. Set `DEMO_ADMIN_TOKEN` in the environment (or `fly secrets set`) to use the private controls; they answer 401 when it is missing.

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

## Phone line (sample, not switched on)

`src/phone/` adds a read-only "where's my order" phone line for Sam's Café. Nothing in it can change an order.

- `POST /phone/lookup`: body `{ "orderNumber": "...", "contact": "<AU phone or email>" }`, header `x-phone-line-key`. Returns `{ match: true, status, say }` only when the contact belongs to the order, otherwise the same `{ match: false, say }` whatever was wrong. AU phone formats and email case are normalised. Limited to 30 lookups a minute, and an order number with 5 wrong tries in 15 minutes is held (same "couldn't match" answer).
- `src/phone/flow.ts`: the call as a pure state machine (greet, order number, contact, status; change requests, "talk to someone" and two failed matches go to the owner; no answer means a message and a text to the owner).
- `src/phone/session.ts`: runs the flow against phone, text and lookup adapters (mocked in `test/phone.test.ts`).
- `GET /calls`: the private call log, behind a sign-in.
- Orders come from a sample order book in `src/phone/orders.ts` (ACMA fiction-range numbers, example.com emails). It is part of the build, so it is the same after every restart.

Both routes answer 404 until these are set with `fly secrets set` (never in the repo): `PHONE_LINE_KEY`, `CALL_LOG_USER`, `CALL_LOG_PASSWORD`. Optional: `CALL_LOG_PATH` (keep it on a volume, or calls are lost on restart), `SHOP_TIME_ZONE` (default Australia/Sydney), `DATA_SEED_PATH` (start the shop from a saved copy when the data file is missing; `GET /admin/state` downloads one).
