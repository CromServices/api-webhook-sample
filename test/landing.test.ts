import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";
import { THEME_CSS_URL } from "../src/landing.ts";

describe("GET / landing page", () => {
  let server: Server;
  let baseUrl = "";

  before(async () => {
    const app = createApp({ webhookSecret: "test-secret-not-for-production" });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("expected TCP address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 200 HTML with the Crom credit link", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /<footer class="crom-footer">/);
    assert.match(html, /<a href="https:\/\/cromservices\.com\.au"[^>]*aria-label="Built by Crom Services"/);
    assert.match(html, /Crom Services · Australia/);
  });

  it("uses only the pinned shared theme (no inline stylesheet, no theme slot)", async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    assert.equal(THEME_CSS_URL, "https://cdn.jsdelivr.net/gh/CromServices/crom-shared@v1.0.0/theme.css");
    assert.ok(html.includes(`<link rel="stylesheet" href="${THEME_CSS_URL}">`));
    assert.equal((html.match(/rel="stylesheet"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /<style/);
    assert.doesNotMatch(html, /CROM THEME SLOT/);
  });

  it("explains the sample and links /health and the docs", async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    assert.match(html, /HMAC/);
    assert.match(html, /illustration only/);
    assert.match(html, /href="\/health"/);
    assert.match(html, /href="https:\/\/cromservices\.github\.io\/api-webhook-sample\/"/);
  });

  it("keeps the public face clean (no city, state, postcode or price)", async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    assert.doesNotMatch(html, /Perth|\bWA\b|6162|\$\s?\d|\bAUD\b|\bprice/i);
  });

  it("leaves /health as {ok:true}", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});
