import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEMO_WEBHOOK_BODY, DEMO_WEBHOOK_SECRET } from "../features/ad-leads/app.ts";
import { signBody } from "../shared/verify.ts";
import { createServerApp } from "../src/compose.ts";

describe("shared server routes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "crom-compose-"));
  const app = createServerApp({
    webhookSecret: DEMO_WEBHOOK_SECRET,
    appSecret: "test-meta-app-secret",
    verifyToken: "test-verify-token",
    adminToken: "",
    leadsDataPath: path.join(dir, "leads.json"),
    ordersDataPath: path.join(dir, "demo-shop.json"),
  });
  let server: Server;
  let base = "";

  before(async () => {
    server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    base = `http://127.0.0.1:${addr.port}`;
  });

  async function html(route: string): Promise<string> {
    const res = await fetch(`${base}${route}`);
    assert.equal(res.status, 200, route);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/, route);
    return res.text();
  }

  it("keeps the leads pages on their existing routes", async () => {
    const home = await html("/");
    assert.match(home, /<title>Ad leads into your sheet: sample<\/title>/);
    assert.match(home, /Catering enquiries land in your sheet/);
    for (const route of ["/sheet", "/alerts", "/happened", "/before-after", "/before-after?view=triage"]) {
      const page = await html(route);
      assert.match(page, /<title>Ad leads into your sheet: sample<\/title>/, route);
    }
  });

  it("serves the shop pages and the shop home without taking over /", async () => {
    for (const route of ["/shop", "/stock", "/history", "/shop-before-after", "/shop-before-after?view=triage"]) {
      const page = await html(route);
      assert.match(page, /<title>Shop-to-stock order sync: sample<\/title>/, route);
    }
    const shopHome = await html("/shop-and-stock");
    assert.match(shopHome, /<title>Shop-to-stock order sync: sample<\/title>/);
    assert.match(shopHome, /Connect your systems/);
    assert.match(shopHome, /Place an order once/);
  });

  it("leaves /health as {ok:true} and still accepts the published signed check", async () => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const signed = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-256": `sha256=${signBody(DEMO_WEBHOOK_SECRET, DEMO_WEBHOOK_BODY)}`,
      },
      body: DEMO_WEBHOOK_BODY,
    });
    assert.equal(signed.status, 200);
    assert.deepEqual(await signed.json(), { received: true });

    const handshake = await fetch(`${base}/leadgen`);
    assert.equal(handshake.status, 403);

    const side = await fetch(`${base}/demo`, { redirect: "manual" });
    assert.equal(side.status, 301);
    assert.equal(side.headers.get("location"), "/shop-before-after");
    const triage = await fetch(`${base}/demo?view=triage`, { redirect: "manual" });
    assert.equal(triage.status, 301);
    assert.equal(triage.headers.get("location"), "/shop-before-after?view=triage");
  });

  after(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });
});
