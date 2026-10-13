# API webhook sample · Crom Services

A scoped Express receiver. `POST /webhook` still checks an HMAC-SHA256 signature over the raw body. `GET` and `POST /leadgen` take a Facebook Lead Ads notification, look the lead up locally, and either write a sheet row plus an owner alert, or leave it for a hand copy.

<!-- Built on CromServices/crom-ts-api-starter at b2cd23a (package.json "starter.config"). Shared files come from the starter; do not edit them here first. -->

## What it is

A public sample for one job: catering enquiries from a Facebook lead form land in a sheet, and the owner is told. It is for illustration only, not a client system. There is no Meta account, no live send, and no spend. The people are fictional.

The Facebook app secret and the verify token are generated in memory when `META_APP_SECRET` and `META_VERIFY_TOKEN` are unset. They are never written into the repo. `DEMO_ADMIN_TOKEN` unlocks the private controls used to run the two ways; leave it unset and those controls stay closed. The original signed check still uses the published value `crom-demo-webhook-secret-v1`.

Public pages stay in plain language (names, phones, what they asked for). The browser title is the only place that says sample. Labels live in `src/story.ts`. Counts on the pages are read from the stored runs.

- `GET /` shows the leads Facebook has and the rows in the sheet, from the stored file.
- `GET /sheet` is the sheet: date, name, phone, email, what they want, source form, and New or Contacted.
- `GET /alerts` is the owner alerts, stored here. Nothing is emailed or texted.
- `GET /happened` is what the current run did, in plain language, with no clock times.
- `GET /before-after` reads the saved before-run and after-run. `GET /before-after?view=triage` counts the before-run: what was checked, what was found, what was fixed first, and what was left for later.
- `GET /health` returns `{"ok":true}`.
- `GET /leadgen` answers the verify handshake (`hub.mode`, `hub.verify_token`, `hub.challenge`).
- `POST /leadgen` checks `X-Hub-Signature-256` (`sha256=<hex>` HMAC-SHA256 of the raw body, app secret). A leadgen change is then filled in from a local stand-in of the lead-details lookup. A bad signature is turned away and nothing is written.
- `POST /webhook` is the original check: `X-Signature-256` over the raw body, `200 {"received":true}` or `401` (fail-closed).

The old way stores the lead and waits. A delayed hand copy then writes the rows it already had, misses a lead that arrived during the wait, and repeats a lead that was sent twice. It writes no alerts. The fixed way writes one row, blocks a duplicate, tries a failed delivery once, and stores an alert.

| Path | Purpose |
|---|---|
| `src/verify.ts` | Sign and verify helpers (timing-safe compare) |
| `src/leadgen.ts` | Leadgen notice, lead-details tidy, Australian phone |
| `src/graph.ts` | Local stand-in for the lead-details lookup |
| `src/store.ts` | Facebook leads, sheet rows, alerts, attempts, the two saved runs |
| `src/deliver.ts` | Sends one notice and tries a failed delivery once |
| `src/scenario.ts` | The same fictional leads, run both ways |
| `src/present.ts` | Turns stored rows into the words on the pages |
| `src/pages.ts` | Page HTML |
| `src/story.ts` | Customer-facing labels |
| `src/app.ts` | `createApp()`: public pages, both receivers, private controls |
| `src/landing.ts` | crom-shared v1.0.2 header and footer, pinned |
| `src/server.ts` | Listen entry (`PORT`, `HOST`, `WEBHOOK_SECRET`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `DATA_PATH`, `DEMO_ADMIN_TOKEN`) |
| `src/run-sample.ts` | Runs both ways and writes the notes |
| `test/` | `node:test` suites |
| `docs/` | Plain-language page for GitHub Pages |
| `Dockerfile`, `fly.toml` | Disposable host (`crom-api-webhook-demo`, `syd`). This branch does not deploy. |

## What it proves

- A Lead Ads notification checked the way Facebook signs it, then filled in from the lead-details shape, with a verify handshake.
- A bad signature never becomes a row. A repeated lead, or the same person again inside a short window, does not become a second row. A failed delivery is tried once. Phones are stored in Australian form.
- The hand-copy path really misses and repeats, and writes no alert. The fixed path writes the row and the alert.
- The same toolchain as every Crom Services TypeScript API: strict TypeScript, `node:test`, a multi-stage `Dockerfile` and `fly.toml`.

Does not prove: a live Meta app, a real CRM, or a sent email or text.

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

`npm run build` compiles to `dist/`, and `npm start` runs the compiled server. `PORT` defaults to 3000. `WEBHOOK_SECRET` defaults to the published demo value. `META_APP_SECRET` and `META_VERIFY_TOKEN` default to a new random value each start. `npm run sample` runs the before and after leads against a fresh file.

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
