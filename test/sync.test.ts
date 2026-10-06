import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp, type DemoApp } from "../src/app.ts";
import { orderPayload } from "../src/deliver.ts";
import { madeArrived, orderLine } from "../src/story.ts";
import type { State } from "../src/store.ts";
import { signBody } from "../src/verify.ts";

const SECRET = "test-secret-not-for-production";
const TOKEN = "test-admin-token";

function readState(dataPath: string): State {
  return JSON.parse(readFileSync(dataPath, "utf8")) as State;
}

async function waitFor<T>(read: () => T | null, ms = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error("timed out waiting for stored data");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function boot(opts?: { timeout?: number; delays?: number[] }) {
  const dataPath = path.join(mkdtempSync(path.join(tmpdir(), "crom-sync-")), "demo-shop.json");
  let base = "";
  const app: DemoApp = createApp({
    webhookSecret: SECRET,
    adminToken: TOKEN,
    dataPath,
    webhookUrl: () => `${base}/webhook`,
    clientTimeoutMs: opts?.timeout ?? 80,
    retryDelaysMs: opts?.delays ?? [40, 80],
  });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
  return { app, server, base, dataPath };
}

async function admin(base: string, route: string, body: unknown, token = TOKEN) {
  return fetch(`${base}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function postRaw(base: string, raw: string, signature: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["x-signature-256"] = signature;
  return fetch(`${base}/webhook`, { method: "POST", headers, body: raw });
}

async function place(base: string, product: string, qty = 1) {
  const res = await fetch(`${base}/shop/orders`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `product=${encodeURIComponent(product)}&qty=${qty}`,
    redirect: "manual",
  });
  assert.equal(res.status, 303);
}

describe("shop and stock", () => {
  let server: Server;
  let base = "";
  let dataPath = "";

  before(async () => {
    const started = await boot();
    server = started.server;
    base = started.base;
    dataPath = started.dataPath;
  });

  after(async () => {
    await admin(base, "/admin/reset", { mode: "fixed" });
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("stocks one order once when the same signed body is posted twice", async () => {
    const raw = orderPayload({ id: "9001", product: "Flat white", qty: 1 });
    const sig = signBody(SECRET, raw);
    const first = await postRaw(base, raw, sig);
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as { duplicate?: boolean }).duplicate, false);
    const second = await postRaw(base, raw, sig);
    assert.equal(second.status, 200);
    const body = (await second.json()) as { received: boolean; duplicate: boolean };
    assert.equal(body.received, true);
    assert.equal(body.duplicate, true);
    const state = readState(dataPath);
    assert.equal(state.stockOrders.filter((row) => row.id === "9001").length, 1);
    assert.equal(state.products.find((row) => row.name === "Flat white")?.onHand, 11);
  });

  it("keeps a non-order body on the published check, even while stock is down", async () => {
    const down = await admin(base, "/admin/stock", { up: false });
    assert.equal(down.status, 200);
    const raw = '{"event":"ping"}';
    const res = await postRaw(base, raw, signBody(SECRET, raw));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true });
    const order = orderPayload({ id: "9002", product: "Flat white", qty: 1 });
    const blocked = await postRaw(base, order, signBody(SECRET, order));
    assert.equal(blocked.status, 503);
    assert.deepEqual(await blocked.json(), { received: false });
    assert.equal(readState(dataPath).stockOrders.some((row) => row.id === "9002"), false);
    const up = await admin(base, "/admin/stock", { up: true });
    assert.equal(up.status, 200);
  });

  it("closes the private controls when the bearer is missing or wrong", async () => {
    const missing = await fetch(`${base}/admin/stock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ up: false }),
    });
    assert.equal(missing.status, 401);
    const wrong = await admin(base, "/admin/stock", { up: false }, "nope");
    assert.equal(wrong.status, 401);
    assert.equal(readState(dataPath).stockUp, true);
  });

  it("does not note a failed check that is not an order", async () => {
    const before = readState(dataPath).attempts.length;
    const res = await postRaw(
      base,
      JSON.stringify({ hello: "world" }),
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "invalid signature" });
    assert.equal(readState(dataPath).attempts.length, before);
  });

  it("notes a failed check in the fixed run and leaves it out of the shop and the stock", async () => {
    const beforeHand = readState(dataPath).products.find((row) => row.name === "Banana bread")?.onHand;
    const res = await admin(base, "/admin/bad-delivery", {
      product: "Banana bread",
      qty: 1,
      onShop: false,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; status: number };
    assert.equal(body.status, 401);
    const state = readState(dataPath);
    assert.equal(state.shopOrders.some((row) => row.id === body.id), false);
    assert.equal(state.stockOrders.some((row) => row.id === body.id), false);
    assert.equal(state.products.find((row) => row.name === "Banana bread")?.onHand, beforeHand);
    const noted = state.attempts.filter((row) => row.orderId === body.id);
    assert.equal(noted.length, 1);
    assert.equal(noted[0]?.outcome, "rejected");
    assert.equal(noted[0]?.httpStatus, 401);
  });

  it("sends again after stock is down and keeps a single stock row", async () => {
    assert.equal((await admin(base, "/admin/stock", { up: false })).status, 200);
    await place(base, "Long black", 1);
    const down = await waitFor(() => {
      const state = readState(dataPath);
      const attempt = state.attempts.find(
        (row) => row.product === "Long black" && row.outcome === "down",
      );
      return attempt ?? null;
    });
    assert.equal(down.httpStatus, 503);
    assert.equal(readState(dataPath).stockOrders.some((row) => row.product === "Long black"), false);
    assert.equal((await admin(base, "/admin/stock", { up: true })).status, 200);
    const done = await waitFor(() => {
      const state = readState(dataPath);
      const rows = state.stockOrders.filter((row) => row.product === "Long black");
      const ok = state.attempts.find((row) => row.product === "Long black" && row.outcome === "ok");
      if (rows.length === 1 && ok) return state;
      return null;
    });
    assert.equal(done.products.find((row) => row.name === "Long black")?.onHand, 11);
    assert.equal(done.stockOrders.filter((row) => row.product === "Long black").length, 1);
  });
});

describe("old behaviour", () => {
  let server: Server;
  let base = "";
  let dataPath = "";

  before(async () => {
    const started = await boot({ timeout: 80, delays: [40] });
    server = started.server;
    base = started.base;
    dataPath = started.dataPath;
    assert.equal((await admin(base, "/admin/mode", { mode: "old" })).status, 200);
  });

  after(async () => {
    await admin(base, "/admin/reset", { mode: "fixed" });
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("appends a second stock row when the same signed body is posted twice", async () => {
    const raw = orderPayload({ id: "9101", product: "Flat white", qty: 1 });
    const sig = signBody(SECRET, raw);
    assert.equal((await postRaw(base, raw, sig)).status, 200);
    assert.equal((await postRaw(base, raw, sig)).status, 200);
    const state = readState(dataPath);
    assert.equal(state.stockOrders.filter((row) => row.id === "9101").length, 2);
    assert.equal(state.products.find((row) => row.name === "Flat white")?.onHand, 10);
    assert.equal(state.attempts.length, 0);
  });

  it("records twice when the first reply is slower than the sender gives up", async () => {
    assert.equal((await admin(base, "/admin/slow", { ms: 250 })).status, 200);
    await place(base, "Long black", 1);
    const state = await waitFor(() => {
      const current = readState(dataPath);
      const rows = current.stockOrders.filter((row) => row.product === "Long black");
      const attempts = current.attempts.filter((row) => row.product === "Long black");
      const down = attempts.some((row) => row.outcome === "down");
      const ok = attempts.some((row) => row.outcome === "ok");
      if (rows.length === 2 && down && ok) return current;
      return null;
    });
    assert.equal(state.products.find((row) => row.name === "Long black")?.onHand, 10);
    assert.equal((await admin(base, "/admin/slow", { ms: 0 })).status, 200);
  });

  it("leaves a failed check off the history when the shop is on the old path", async () => {
    const res = await admin(base, "/admin/bad-delivery", {
      product: "Banana bread",
      qty: 1,
      onShop: true,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; status: number };
    assert.equal(body.status, 401);
    const state = readState(dataPath);
    const shop = state.shopOrders.find((row) => row.id === body.id);
    assert.equal(shop?.hold, true);
    assert.equal(shop?.product, "Banana bread");
    assert.equal(state.stockOrders.some((row) => row.id === body.id), false);
    assert.equal(state.attempts.filter((row) => row.orderId === body.id).length, 0);
    assert.equal(state.products.find((row) => row.name === "Banana bread")?.onHand, 12);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const later = readState(dataPath);
    assert.equal(later.stockOrders.some((row) => row.id === body.id), false);
    assert.equal(later.attempts.filter((row) => row.orderId === body.id).length, 0);
    assert.equal(later.products.find((row) => row.name === "Banana bread")?.onHand, 12);
  });
});

describe("missing shop orders", () => {
  let server: Server;
  let base = "";
  let dataPath = "";

  before(async () => {
    const started = await boot({ timeout: 80, delays: [40] });
    server = started.server;
    base = started.base;
    dataPath = started.dataPath;
  });

  after(async () => {
    await admin(base, "/admin/reset", { mode: "fixed" });
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("resends a missing order exactly once", async () => {
    const res = await admin(base, "/admin/bad-delivery", {
      product: "Banana bread",
      qty: 1,
      onShop: true,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; status: number };
    assert.equal(body.status, 401);
    const state = await waitFor(() => {
      const current = readState(dataPath);
      const stock = current.stockOrders.filter((row) => row.id === body.id);
      const ok = current.attempts.filter((row) => row.orderId === body.id && row.outcome === "ok");
      const rejected = current.attempts.filter(
        (row) => row.orderId === body.id && row.outcome === "rejected",
      );
      if (stock.length === 1 && ok.length === 1 && rejected.length === 1) return current;
      return null;
    });
    assert.equal(state.products.find((row) => row.name === "Banana bread")?.onHand, 11);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const later = readState(dataPath);
    assert.equal(later.stockOrders.filter((row) => row.id === body.id).length, 1);
    assert.equal(later.attempts.filter((row) => row.orderId === body.id && row.outcome === "ok").length, 1);
    const home = await (await fetch(`${base}/`)).text();
    assert.match(home, /Didn't arrive, sent again, arrived/);
    assert.doesNotMatch(home, /Rejected, not from your shop/);
    const history = await (await fetch(`${base}/history`)).text();
    assert.match(history, /Didn't arrive, sent again, arrived/);
    assert.doesNotMatch(history, /Rejected, not from your shop/);
  });

  it("never resends an order stock already has", async () => {
    await place(base, "Flat white");
    const order = await waitFor(() => {
      const current = readState(dataPath);
      const row = current.shopOrders.find((item) => item.product === "Flat white");
      if (!row) return null;
      const stock = current.stockOrders.filter((item) => item.id === row.id);
      const ok = current.attempts.filter((item) => item.orderId === row.id && item.outcome === "ok");
      if (stock.length === 1 && ok.length === 1) return row;
      return null;
    });
    const before = readState(dataPath).attempts.filter((row) => row.orderId === order.id).length;
    await new Promise((resolve) => setTimeout(resolve, 800));
    const later = readState(dataPath);
    assert.equal(later.stockOrders.filter((row) => row.id === order.id).length, 1);
    assert.equal(later.attempts.filter((row) => row.orderId === order.id).length, before);
  });

  it("never recovers a forged delivery the shop never made", async () => {
    const hand = readState(dataPath).products.find((row) => row.name === "Long black")?.onHand;
    const res = await admin(base, "/admin/bad-delivery", {
      product: "Long black",
      qty: 1,
      onShop: false,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; status: number };
    assert.equal(body.status, 401);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const state = readState(dataPath);
    assert.equal(state.shopOrders.some((row) => row.id === body.id), false);
    assert.equal(state.stockOrders.some((row) => row.id === body.id), false);
    assert.equal(state.attempts.filter((row) => row.orderId === body.id && row.outcome === "ok").length, 0);
    assert.equal(state.attempts.filter((row) => row.orderId === body.id && row.outcome === "rejected").length, 1);
    assert.equal(state.products.find((row) => row.name === "Long black")?.onHand, hand);
    const home = await (await fetch(`${base}/`)).text();
    assert.match(home, /Rejected, not from your shop/);
  });
});

describe("saved before and after", () => {
  let server: Server;
  let base = "";
  let dataPath = "";

  before(async () => {
    const started = await boot({ timeout: 80, delays: [30, 60] });
    server = started.server;
    base = started.base;
    dataPath = started.dataPath;
  });

  after(async () => {
    await admin(base, "/admin/reset", { mode: "fixed" });
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("keeps both runs and shows them side by side from the stored file", async () => {
    assert.equal((await admin(base, "/admin/mode", { mode: "old" })).status, 200);
    await place(base, "Flat white");
    await waitFor(() => {
      const state = readState(dataPath);
      return state.stockOrders.some((row) => row.product === "Flat white") ? state : null;
    });
    assert.equal((await admin(base, "/admin/slow", { ms: 250 })).status, 200);
    await place(base, "Long black");
    await waitFor(() => {
      const rows = readState(dataPath).stockOrders.filter((row) => row.product === "Long black");
      return rows.length === 2 ? rows : null;
    });
    assert.equal((await admin(base, "/admin/slow", { ms: 0 })).status, 200);
    const missing = await admin(base, "/admin/bad-delivery", {
      product: "Banana bread",
      qty: 1,
      onShop: true,
    });
    assert.equal(missing.status, 200);
    assert.equal((await admin(base, "/admin/snapshot", { name: "before" })).status, 200);

    assert.equal((await admin(base, "/admin/reset", { mode: "fixed" })).status, 200);
    assert.equal(readState(dataPath).shopOrders.length, 0);
    assert.ok(readState(dataPath).snapshots.before);

    await place(base, "Flat white");
    const first = await waitFor(() => {
      const state = readState(dataPath);
      const row = state.shopOrders.find((order) => order.product === "Flat white");
      if (row && state.stockOrders.some((stock) => stock.id === row.id)) return row;
      return null;
    });
    assert.equal((await admin(base, "/admin/stock", { up: false })).status, 200);
    await place(base, "Long black");
    await waitFor(() =>
      readState(dataPath).attempts.some((row) => row.product === "Long black" && row.outcome === "down")
        ? true
        : null,
    );
    assert.equal((await admin(base, "/admin/stock", { up: true })).status, 200);
    await waitFor(() => {
      const state = readState(dataPath);
      const rows = state.stockOrders.filter((row) => row.product === "Long black");
      return rows.length === 1 ? state : null;
    });
    await place(base, "Banana bread");
    await waitFor(() =>
      readState(dataPath).stockOrders.some((row) => row.product === "Banana bread") ? true : null,
    );
    assert.equal((await admin(base, "/admin/resend", { id: first.id })).status, 200);
    await waitFor(() =>
      readState(dataPath).attempts.some((row) => row.orderId === first.id && row.outcome === "duplicate")
        ? true
        : null,
    );
    const noted = await admin(base, "/admin/bad-delivery", {
      product: "Flat white",
      qty: 1,
      onShop: false,
    });
    assert.equal(noted.status, 200);
    const notedId = ((await noted.json()) as { id: string }).id;
    assert.equal((await admin(base, "/admin/snapshot", { name: "after" })).status, 200);

    const state = readState(dataPath);
    const before = state.snapshots.before;
    const afterShot = state.snapshots.after;
    assert.ok(before);
    assert.ok(afterShot);
    assert.equal(before.shopOrders.length, 3);
    assert.equal(new Set(before.stockOrders.map((row) => row.id)).size, 2);
    assert.equal(before.stockOrders.length, 3);
    assert.equal(afterShot.shopOrders.length, 3);
    assert.equal(new Set(afterShot.stockOrders.map((row) => row.id)).size, 3);
    assert.equal(afterShot.stockOrders.filter((row) => row.id === first.id).length, 1);
    assert.equal(afterShot.shopOrders.some((row) => row.id === notedId), false);
    assert.equal(afterShot.attempts.some((row) => row.orderId === notedId && row.outcome === "rejected"), true);
    assert.equal(
      afterShot.products.find((row) => row.name === "Flat white")?.onHand,
      11,
    );

    const demo = await (await fetch(`${base}/demo`)).text();
    assert.match(demo, /Made 3\. Arrived 2\./);
    assert.match(demo, /Made 3\. Arrived 3\./);
    assert.match(demo, /Arrived twice/);
    assert.match(demo, /Never arrived/);
    assert.match(demo, /Duplicate stopped/);
    assert.match(demo, /Rejected, not from your shop/);
    assert.match(demo, /Didn't arrive, sent again, arrived/);
    assert.doesNotMatch(demo, /Demo shop, not a real business|See the code on GitHub|Sample · example project/);
    assert.match(demo, /Sam's Café · shop and stock/);
    assert.doesNotMatch(demo, /\b\d{1,2}:\d{2}\s*(am|pm)\b/i);
    assert.equal((demo.match(/>What we checked</g) ?? []).length, 1);
    assert.match(demo, /<title>Shop-to-stock order sync: sample<\/title>/);
    const visible = demo.replace(/<[^>]*>/g, " ");
    assert.doesNotMatch(visible, /webhook|hmac|signature|payload|\b401\b|\b200\b/i);
    assert.doesNotMatch(demo, /\d{4}-\d{2}-\d{2}T/);
    assert.match(demo, new RegExp(madeArrived(3, 3)));

    const triage = await (await fetch(`${base}/demo?view=triage`)).text();
    const beforeShot = state.snapshots.before;
    assert.ok(beforeShot);
    const never = beforeShot.shopOrders.filter(
      (order) => !beforeShot.stockOrders.some((row) => row.id === order.id),
    );
    const twice = beforeShot.shopOrders.filter(
      (order) => beforeShot.stockOrders.filter((row) => row.id === order.id).length >= 2,
    );
    assert.equal(never.length, 1);
    assert.equal(twice.length, 1);
    assert.match(triage, /Orders made: 3\. Orders that arrived in stock: 2\./);
    assert.match(triage, /1 never arrived/);
    assert.match(triage, /1 arrived twice/);
    assert.doesNotMatch(triage, /not from your shop/);
    for (const order of [...never, ...twice]) {
      assert.match(triage, new RegExp(orderLine(order.id, order.qty, order.product).replace(/[.]/g, "\\.")));
    }
    assert.match(triage, /Missing orders first, because a missing order is a lost sale/);
    assert.match(triage, /Duplicates next, because they make the stock count wrong/);
    assert.match(triage, /Then a turned-away order is noted, so it is not lost/);
    assert.match(triage, /Orders from before the switch-on weren't copied across/);
    assert.doesNotMatch(triage, /Demo shop, not a real business|See the code on GitHub|Sample · example project/);
    assert.match(triage, /Sam's Café · shop and stock/);
    assert.doesNotMatch(triage, /\b\d{1,2}:\d{2}\s*(am|pm)\b/i);
    const history = await (await fetch(`${base}/history`)).text();
    assert.match(history, /Sam's Café · shop and stock/);
    assert.doesNotMatch(history, /\b\d{1,2}:\d{2}\s*(am|pm)\b/i);
    assert.match(history, /Didn't arrive, sent again, arrived/);
    assert.equal((triage.match(/>Before and after</g) ?? []).length, 1);
    assert.doesNotMatch(triage, /\d{4}-\d{2}-\d{2}T/);
  });
});
