import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServerApp } from "../src/compose.ts";

async function boot(dir: string) {
  const app = createServerApp({
    webhookSecret: "reseed-secret",
    appSecret: "reseed-app-secret",
    verifyToken: "reseed-verify",
    adminToken: "",
    leadsDataPath: path.join(dir, "leads.json"),
    ordersDataPath: path.join(dir, "demo-shop.json"),
    seedIfEmpty: true,
  });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return { server, base: `http://127.0.0.1:${addr.port}` };
}

describe("reseed empty stores on boot", () => {
  const servers: Server[] = [];

  after(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      ),
    );
  });

  it("loads both stored runs when the data files are missing", async () => {
    const started = await boot(mkdtempSync(path.join(tmpdir(), "crom-reseed-")));
    servers.push(started.server);
    const home = await (await fetch(`${started.base}/`)).text();
    const before = await (await fetch(`${started.base}/before-after`)).text();
    const shop = await (await fetch(`${started.base}/shop-before-after`)).text();
    const shopHome = await (await fetch(`${started.base}/shop-and-stock`)).text();
    assert.match(home, /New leads: 3\. In your sheet: 3/);
    assert.match(home, /Jordan Hale/);
    assert.doesNotMatch(home, /New leads: 0\. In your sheet: 0/);
    assert.match(before, /New leads: 3\. In your sheet: 2 \(1 copied twice, 1 missing\)/);
    assert.match(before, /New leads: 3\. In your sheet: 3/);
    assert.match(before, /Riley Tran/);
    assert.match(shop, /Made 3\. Arrived 2\./);
    assert.match(shop, /Made 3\. Arrived 3\./);
    assert.match(shopHome, /Made 3\. Arrived 3\./);
    assert.match(shop, /Flat white/);
  });

  it("leaves a store that already has a run", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crom-reseed-keep-"));
    writeFileSync(
      path.join(dir, "leads.json"),
      JSON.stringify({
        openedAt: "2020-01-01T00:00:00.000Z",
        mode: "fixed",
        duplicateWindowMs: 1800000,
        facebookLeads: [
          {
            leadgenId: "1",
            name: "Kept Person",
            phone: "0400 000 000",
            phoneRaw: "0400000000",
            email: "kept@example.com",
            want: "Keep this row",
            formName: "Catering enquiry",
            createdTime: "2020-01-01T00:00:00.000Z",
            arrivedAt: "2020-01-02T00:00:00.000Z",
            notifyCount: 1,
            prior: false,
          },
        ],
        sheetRows: [],
        alerts: [],
        attempts: [],
        exportBatch: null,
        copyPhase: "idle",
        pendingCopy: null,
        snapshots: { before: null, after: null },
      }),
    );
    writeFileSync(
      path.join(dir, "demo-shop.json"),
      JSON.stringify({
        openedAt: "2020-01-01T00:00:00.000Z",
        mode: "fixed",
        stockUp: true,
        slowMs: 0,
        nextId: 1042,
        products: [{ name: "Flat white", onHand: 12, opening: 12 }],
        shopOrders: [
          { id: "1041", product: "Kept loaf", qty: 1, placedAt: "2020-01-02T00:00:00.000Z", hold: false },
        ],
        stockOrders: [],
        attempts: [],
        controls: [],
        snapshots: { before: null, after: null },
      }),
    );
    const started = await boot(dir);
    servers.push(started.server);
    const home = await (await fetch(`${started.base}/`)).text();
    const shop = await (await fetch(`${started.base}/shop-and-stock`)).text();
    assert.match(home, /Kept Person/);
    assert.doesNotMatch(home, /Jordan Hale/);
    assert.match(shop, /Kept loaf/);
    assert.doesNotMatch(shop, /Made 3\. Arrived 3\./);
  });
});
