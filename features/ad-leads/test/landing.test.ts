import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../app.ts";
import { THEME_CSS_URL } from "../../../shared/landing.ts";

const PIN = "https://cdn.jsdelivr.net/gh/CromServices/crom-shared@v1.0.2/";

function visible(html: string): string {
  const body = html.slice(html.indexOf("<body"));
  return body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

describe("public pages", () => {
  let server: Server;
  let base = "";
  let html = "";

  before(async () => {
    const app = createApp({
      webhookSecret: "test-secret-not-for-production",
      appSecret: "test-meta-app-secret",
      verifyToken: "test-verify-token",
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("expected TCP address");
    base = `http://127.0.0.1:${addr.port}`;
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    html = await res.text();
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("uses the Crom header, footer and pinned theme", () => {
    assert.match(html, /<footer class="crom-footer">/);
    assert.match(html, /<a href="https:\/\/cromservices\.com\.au"[^>]*aria-label="Built by Crom Services"/);
    assert.match(html, /Crom Services · Australia/);
    assert.doesNotMatch(html, /cromservices@gmail\.com/);
    assert.doesNotMatch(html, /mailto:/);
    assert.equal(THEME_CSS_URL, `${PIN}theme.css`);
    assert.ok(html.includes(`<link rel="stylesheet" href="${THEME_CSS_URL}">`));
    assert.equal((html.match(/rel="stylesheet"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /<style/);
    assert.match(html, /<header class="crom-header">/);
    assert.doesNotMatch(html, /crom-tag/);
    assert.ok(html.includes(`<source media="(prefers-color-scheme: dark)" srcset="${PIN}brand/logo/crom-logo-v26-white.png">`));
    assert.ok(html.includes(`<img class="crom-logo" src="${PIN}brand/logo/crom-logo-v26-ink.png"`));
  });

  it("names the café and keeps the sample marker to the browser title", () => {
    assert.match(html, /<title>Ad leads into your sheet: sample<\/title>/);
    assert.match(html, /Sam's Café · catering leads/);
    assert.match(html, /Catering enquiries land in your sheet/);
    assert.doesNotMatch(visible(html), /\bsample\b|\bdemo\b|\bexample\b/i);
    assert.doesNotMatch(html, /github\.com/i);
  });

  it("shows the empty book from storage and leaves technical words out", () => {
    assert.match(html, /New leads: 0\. In your sheet: 0/);
    assert.match(html, /No leads yet/);
    assert.match(html, /No rows yet/);
    assert.doesNotMatch(
      visible(html),
      /\b(webhook|payload|signature|apis?|bots?|guid|uuid)\b|\bAI\b|\b\d{1,2}:\d{2}\b/i,
    );
  });

  it("leaves /health as {ok:true}", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});
