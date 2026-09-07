# API webhook sample — Crom Services

Public sample of how Crom Services approaches small API and webhook work.

This folder demonstrates a minimal Express TypeScript endpoint that verifies a shared-secret header on POST /webhook and returns 200 on success or 401 on failure.
Portfolio overflow sample only — not a client system.

## Purpose

- Clear, testable request verification pattern
- Illustrates Crom Services capability for API overflow and small builds
- Sample secret via environment only; nothing sensitive in the repo

## Stack

- TypeScript and Node.js 18+
- Express
- node:crypto for HMAC-SHA256 with timing-safe compare
- Tests via node:test (tsx loader)

## Layout

- src/verify.ts — sign and verify helpers
- src/app.ts — Express app with GET /health and POST /webhook
- src/server.ts — listen entrypoint
- test/webhook.test.ts — unit and HTTP checks

## How to run

Install dependencies with the package manager, then execute the test script.
Optional: start the local server with WEBHOOK_SECRET set in the environment.

Header expected: X-Signature-256 — raw hex or sha256= prefix over the raw JSON body.

## Capability

- Code and PR review packs
- Small builds and patches as PRs
- API and webhook work

Crom Services · Perth WA · Remote across Australia
Trading as Crom Services

Site: https://cromservices.com.au (placeholder)
Contact: cromservices@gmail.com

## License

MIT — see LICENSE.

