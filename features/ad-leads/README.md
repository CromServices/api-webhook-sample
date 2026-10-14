# Ad leads

Catering enquiries from a lead form land in a sheet, and the owner is told. This is the sample from merged pull request 6. Nothing is emailed or texted. The people are fictional and live in `fixtures/people.json`.

## Routes

The running server keeps these paths:

| Path | Page |
|---|---|
| `GET /` | Leads, and the rows already in the sheet |
| `GET /sheet` | The sheet |
| `GET /alerts` | Owner alerts stored here |
| `GET /happened` | What this run did |
| `GET /before-after` | Saved before-run and after-run |
| `GET /before-after?view=triage` | What was checked on the before-run |
| `GET /leadgen` | Verify handshake |
| `POST /leadgen` | Intake |
| `GET /health` | `{"ok":true}` |

`POST /webhook` is the original signed check. On the shared server that check is handled with the shop sample, and a non-order body still returns `200 {"received":true}` or `401`.

## In this folder

| Path | Purpose |
|---|---|
| `app.ts` | `createApp()` for this sample |
| `pages.ts`, `story.ts` | Page HTML and the words on it |
| `store.ts`, `present.ts` | Stored runs, and the words read from them |
| `leadgen.ts`, `graph.ts`, `phone.ts`, `deliver.ts` | Intake, local lookup, phone form, one delivery |
| `scenario.ts` | Runs both ways from `fixtures/people.json` |
| `run-sample.ts` | Writes the notes |
| `test/` | `node:test` for this sample |

Header, footer and the signature check are in `shared/`.
