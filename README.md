# API webhook sample — Crom Services

**Live demo:** [https://crom-api-webhook-demo.fly.dev](https://crom-api-webhook-demo.fly.dev)  
**Health:** [https://crom-api-webhook-demo.fly.dev/health](https://crom-api-webhook-demo.fly.dev/health)  
**Docs (curl + published demo secret):** [https://cromservices.github.io/api-webhook-sample/](https://cromservices.github.io/api-webhook-sample/)

Public sample of how Crom Services approaches small API and webhook work.

This folder demonstrates a minimal Express TypeScript endpoint that verifies a shared-secret header on POST /webhook and returns 200 on success or 401 on failure.
Portfolio overflow sample only — not a client system.

The hosted URL is a **sample crumb**: a disposable public proof that bid paste can link a responding endpoint, not a forever-host for client workloads.

## Purpose

- Clear, testable request verification pattern
- Illustrates Crom Services capability for API overflow and small builds
- Published demo secret only (`crom-demo-webhook-secret-v1`); nothing that belongs to a client lives in this repo

## Stack

- TypeScript and Node.js 18+
- Express
- node:crypto for HMAC-SHA256 with timing-safe compare
- Tests via node:test (tsx loader)
- Hostable via Dockerfile + Fly (`fly.toml`)

## Layout

- src/verify.ts — sign and verify helpers
- src/app.ts — Express app with GET /health and POST /webhook
- src/server.ts — listen entrypoint (`PORT` / `HOST` / `WEBHOOK_SECRET`)
- test/webhook.test.ts — unit and HTTP checks
- docs/ — GitHub Pages site with copy-paste curl against the live demo
- Dockerfile, fly.toml — disposable demo host

## How to run

Install dependencies with the package manager, then execute the test script.
Optional: start the local server. `PORT` defaults to 3000; `WEBHOOK_SECRET` defaults to the published demo value `crom-demo-webhook-secret-v1`.

Header expected: `X-Signature-256` — raw hex or `sha256=` prefix over the raw JSON body.

Fail-closed: missing or invalid signatures return 401. An empty secret is rejected.

```bash
curl -sS https://crom-api-webhook-demo.fly.dev/health
# {"ok":true}
```

Copy-paste POST examples (valid HMAC and 401 fail-closed) are on the [docs page](https://cromservices.github.io/api-webhook-sample/).

## Hosted demo (Fly)

Intended app: `crom-api-webhook-demo` in `syd`. First-time create and deploy (requires a Fly token locally; this repo does not ship one):

```bash
fly apps create crom-api-webhook-demo --org personal
fly deploy
```

`WEBHOOK_SECRET` is documented in `fly.toml` as the public sample value. Rotate with `fly secrets set WEBHOOK_SECRET=...` if the published demo secret changes. Optional GitHub Action `.github/workflows/fly.yml` deploys on `main` when the `FLY_API_TOKEN` repository secret is set.

## GitHub Pages

Docs live in `docs/`. Enable Pages in the repository settings: **Source = GitHub Actions** (workflow `.github/workflows/pages.yml`), or **Deploy from a branch** → `main` / `/docs`.

## Capability

- Code and PR review packs
- Small builds and patches as PRs
- API and webhook work

Crom Services · Perth WA · Remote across Australia
Trading as Crom Services

Site: https://cromservices.github.io/job-page-sample/packs/
Contact: cromservices@gmail.com

## License

MIT — see LICENSE.
