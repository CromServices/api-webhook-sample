import { timingSafeEqual } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { orderPayload, sendMissing, startDelivery, type DeliveryDeps } from "./deliver.ts";
import { demoPage, historyPage, homePage, shopPage, stockPage } from "./pages.ts";
import { openStore, type Picture } from "./store.ts";
import { verifyHmacHeader } from "./verify.ts";
import { mountPhoneLine, type PhoneLineOptions } from "./phone/routes.ts";

/**
 * Published public sample secret for the disposable hosted demo.
 * Rotate-able documentation value only — never a client or production secret.
 */
export const DEMO_WEBHOOK_SECRET = "crom-demo-webhook-secret-v1";

/** Fixed body used in the public docs curl examples. */
export const DEMO_WEBHOOK_BODY = '{"event":"ping"}';

export type AppOptions = {
  /** Shared secret for HMAC verification (published demo default when unset). */
  webhookSecret: string;
  /** JSON file for shop and stock. A private temp file is used when omitted. */
  dataPath?: string;
  /** Bearer token for the private controls. Empty means those controls stay closed. */
  adminToken?: string;
  /** Where the shop posts an order. Defaults to this process on port 3000. */
  webhookUrl?: () => string;
  retryDelaysMs?: number[];
  clientTimeoutMs?: number;
  /** Saved shop to start from when the data file is missing. Unset = start empty, as before. */
  dataSeedPath?: string;
  /** Phone line. Its routes stay closed (404) unless their secrets are set. */
  phoneLine?: PhoneLineOptions;
};

export type DemoApp = Express & {
  resumePending: () => void;
};

type OrderFields = { id: string; product: string; qty: number };

function classify(
  body: unknown,
): { kind: "order"; fields: OrderFields } | { kind: "other" } | { kind: "bad" } {
  if (!body || typeof body !== "object") return { kind: "other" };
  const row = body as Record<string, unknown>;
  if (row.kind !== "order") return { kind: "other" };
  if (typeof row.id !== "string" || !/^\d{1,12}$/.test(row.id)) return { kind: "bad" };
  if (typeof row.product !== "string" || row.product.length === 0 || row.product.length > 80) {
    return { kind: "bad" };
  }
  if (!Number.isInteger(row.qty) || (row.qty as number) < 1 || (row.qty as number) > 20) {
    return { kind: "bad" };
  }
  return { kind: "order", fields: { id: row.id, product: row.product, qty: row.qty as number } };
}

function bearerOk(token: string, header: string | undefined): boolean {
  if (!token || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Shop and stock on one process. GET /health and a signed POST /webhook stay
 * as they were for non-order bodies. Order-shaped bodies are stocked.
 */
export function createApp(opts: AppOptions): DemoApp {
  const dataPath =
    opts.dataPath ?? path.join(mkdtempSync(path.join(tmpdir(), "crom-shop-")), "demo-shop.json");
  const store = openStore(dataPath, opts.dataSeedPath);
  const inflight = new Set<string>();
  const recovered = new Set<string>();
  const deps: DeliveryDeps = {
    secret: opts.webhookSecret,
    webhookUrl: opts.webhookUrl ?? (() => "http://127.0.0.1:3000/webhook"),
    delaysMs: opts.retryDelaysMs ?? [500, 1000, 2000],
    clientTimeoutMs: opts.clientTimeoutMs ?? 400,
    store,
    inflight,
    recovered,
  };
  const missingTimer = setInterval(() => sendMissing(deps), 300);
  missingTimer.unref();

  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );
  app.use(express.urlencoded({ extended: false }));

  function picture(): Picture {
    const state = store.snapshot();
    return {
      products: state.products,
      shopOrders: state.shopOrders,
      stockOrders: state.stockOrders,
      attempts: state.attempts,
    };
  }

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  app.get("/", (_req: Request, res: Response) => {
    res.status(200).type("html").send(homePage(picture()));
  });

  app.get("/shop", (_req: Request, res: Response) => {
    res.status(200).type("html").send(shopPage(picture()));
  });

  app.get("/stock", (_req: Request, res: Response) => {
    res.status(200).type("html").send(stockPage(picture()));
  });

  app.get("/history", (_req: Request, res: Response) => {
    res.status(200).type("html").send(historyPage(picture()));
  });

  app.get("/demo", (req: Request, res: Response) => {
    const state = store.snapshot();
    const view = req.query.view === "triage" ? "triage" : "side";
    res.status(200).type("html").send(demoPage(state.snapshots.before, state.snapshots.after, view));
  });

  app.post("/shop/orders", (req: Request, res: Response) => {
    const product = typeof req.body?.product === "string" ? req.body.product : "";
    const qty = Number(req.body?.qty);
    const order = store.addShopOrder(product, qty, false);
    if (order) startDelivery(order, deps);
    res.redirect(303, "/shop");
  });

  app.post("/webhook", async (req: Request, res: Response) => {
    try {
      const raw =
        (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
      const signature = req.header("x-signature-256") ?? undefined;
      const classified = classify(req.body);

      if (!verifyHmacHeader(opts.webhookSecret, raw, signature)) {
        if (store.mode() === "fixed" && classified.kind === "order") {
          store.logAttempt({
            at: new Date().toISOString(),
            orderId: classified.fields.id,
            product: classified.fields.product,
            qty: classified.fields.qty,
            outcome: "rejected",
            httpStatus: 401,
            waitedMs: 0,
          });
        }
        res.status(401).json({ error: "invalid signature" });
        return;
      }

      if (classified.kind === "bad") {
        res.status(400).json({ received: false });
        return;
      }
      if (classified.kind === "other") {
        res.status(200).json({ received: true });
        return;
      }

      const fields = classified.fields;
      if (!store.isStockUp()) {
        res.status(503).json({ received: false });
        return;
      }

      const delay = store.consumeSlow(fields.id);
      const result = store.mode() === "fixed" ? store.receiveOnce(fields) : store.receiveAgain(fields);
      if (result === "unknown" || result === "short") {
        res.status(409).json({ received: false });
        return;
      }
      if (delay > 0) await sleep(delay);
      if (!res.headersSent) {
        res.status(200).json({ received: true, duplicate: result === "duplicate" });
      }
    } catch {
      if (!res.headersSent) res.status(500).json({ received: false });
    }
  });

  function requireAdmin(req: Request, res: Response): boolean {
    if (!bearerOk(opts.adminToken ?? "", req.header("authorization") ?? undefined)) {
      res.status(401).json({ error: "not allowed" });
      return false;
    }
    return true;
  }

  app.post("/admin/mode", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const mode = req.body?.mode;
    if (mode !== "old" && mode !== "fixed") {
      res.status(400).json({ error: "not allowed" });
      return;
    }
    store.setMode(mode);
    res.status(200).json({ ok: true });
  });

  app.post("/admin/stock", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    if (typeof req.body?.up !== "boolean") {
      res.status(400).json({ error: "not allowed" });
      return;
    }
    store.setStockUp(req.body.up);
    res.status(200).json({ ok: true });
  });

  app.post("/admin/slow", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const ms = req.body?.ms;
    if (!Number.isInteger(ms) || ms < 0 || ms > 10000) {
      res.status(400).json({ error: "not allowed" });
      return;
    }
    store.setSlowMs(ms);
    res.status(200).json({ ok: true });
  });

  app.post("/admin/bad-delivery", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const product = typeof req.body?.product === "string" ? req.body.product : "";
    const qty = Number(req.body?.qty);
    const onShop = req.body?.onShop === true;
    if (!store.knownProduct(product) || !Number.isInteger(qty) || qty < 1 || qty > 20) {
      res.status(400).json({ error: "not allowed" });
      return;
    }
    const order = onShop ? store.addShopOrder(product, qty, true) : null;
    if (onShop && !order) {
      res.status(400).json({ error: "not allowed" });
      return;
    }
    const id = order ? order.id : store.takeId();
    store.mark("bad-delivery", onShop ? `shop ${id}` : `noted ${id}`);
    const raw = orderPayload({ id, product, qty });
    try {
      const response = await fetch(deps.webhookUrl(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature-256": "0".repeat(64),
        },
        body: raw,
      });
      sendMissing(deps);
      res.status(200).json({ ok: true, id, status: response.status });
    } catch {
      res.status(502).json({ error: "not allowed" });
    }
  });

  app.post("/admin/resend", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const id = typeof req.body?.id === "string" ? req.body.id : "";
    const order = store.snapshot().shopOrders.find((row) => row.id === id);
    if (!order) {
      res.status(404).json({ error: "not allowed" });
      return;
    }
    store.mark("resend", id);
    startDelivery(order, deps);
    res.status(200).json({ ok: true });
  });

  app.post("/admin/snapshot", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const name = req.body?.name;
    if (name !== "before" && name !== "after") {
      res.status(400).json({ error: "not allowed" });
      return;
    }
    store.saveSnapshot(name);
    res.status(200).json({ ok: true });
  });

  /** Download the saved shop (to keep as a seed file after a capture run). */
  app.get("/admin/state", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    res.set("cache-control", "no-store");
    res.status(200).json(store.snapshot());
  });

  app.post("/admin/reset", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const mode = req.body?.mode === "old" ? "old" : "fixed";
    inflight.clear();
    recovered.clear();
    store.reset(mode);
    res.status(200).json({ ok: true });
  });

  mountPhoneLine(app, opts.phoneLine);

  return Object.assign(app, {
    resumePending() {
      for (const order of store.pending()) startDelivery(order, deps);
      sendMissing(deps);
    },
  });
}
