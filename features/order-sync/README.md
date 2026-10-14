# Shop-to-stock order sync

Place an order once. It shows in the online shop and in stock. Product names and opening counts live in `fixtures/products.json`.

## Routes

On this sample's own `createApp()`, the home page is `GET /`. The shared server keeps `GET /` for ad leads, and serves this same home page at `GET /shop-and-stock`. The other paths are unchanged:

| Path | Page |
|---|---|
| `GET /` | Shop and stock together (this sample's app) |
| `GET /shop-and-stock` | That same home page on the shared server |
| `GET /shop` | Online shop. Post an order here |
| `GET /stock` | Stock count |
| `GET /history` | What happened |
| `GET /shop-before-after` | Saved before-run and after-run |
| `GET /shop-before-after?view=triage` | What was checked on the before-run |
| `GET /demo` | 301 to `/shop-before-after`, keeping the query |
| `POST /shop/orders` | Place an order |
| `POST /webhook` | Signed check. An order-shaped body is stocked |

## In this folder

| Path | Purpose |
|---|---|
| `app.ts` | `createApp()` for this sample |
| `pages.ts`, `story.ts` | Page HTML and the words on it |
| `store.ts`, `present.ts` | Shop orders, stock rows, and the words read from them |
| `deliver.ts` | Sends an order and tries again until it lands |
| `fixtures/products.json` | Opening stock |
| `test/` | `node:test` for this sample |

Header, footer and the signature check are in `shared/`.
