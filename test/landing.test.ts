import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";
import { THEME_CSS_URL } from "../src/landing.ts";
import { STORY } from "../src/story.ts";

const PIN = "https://cdn.jsdelivr.net/gh/CromServices/crom-shared@v1.0.2/";

/** Visible text only: drop tags (and so every URL inside them). */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

const JARGON =
  /express|hmac|sha-?256|signature|x-signature|webhook|endpoint|\bapi\b|json|\/health|curl|header|payload|\brequest\b|\bretry\b|\berror\b|\blog\b|\b401\b|\b200\b/i;

describe("GET / landing page", () => {
  let server: Server;
  let baseUrl = "";
  let html = "";

  before(async () => {
    const app = createApp({ webhookSecret: "test-secret-not-for-production" });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("expected TCP address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    html = await res.text();
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 200 HTML with the Crom footer and credit link", () => {
    assert.match(html, /<footer class="crom-footer">/);
    assert.match(html, /<a href="https:\/\/cromservices\.com\.au"[^>]*aria-label="Built by Crom Services"/);
    assert.match(html, /Crom Services · Australia/);
  });

  it("uses only the pinned crom-shared v1.0.2 theme (no inline stylesheet, no theme slot)", () => {
    assert.equal(THEME_CSS_URL, `${PIN}theme.css`);
    assert.ok(html.includes(`<link rel="stylesheet" href="${THEME_CSS_URL}">`));
    assert.equal((html.match(/rel="stylesheet"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /<style/);
    assert.doesNotMatch(html, /CROM THEME SLOT/);
    assert.doesNotMatch(html, /crom-shared@v1\.0\.[01]\b|crom-shared@v1\//);
  });

  it("has the Crom header with the pinned ink (light) and white (dark) logos", () => {
    assert.match(html, /<header class="crom-header">/);
    assert.ok(html.includes(`<source media="(prefers-color-scheme: dark)" srcset="${PIN}brand/logo/crom-logo-v26-white.png">`));
    assert.ok(html.includes(`<img class="crom-logo" src="${PIN}brand/logo/crom-logo-v26-ink.png"`));
    assert.match(html, /Sample · example project/);
  });

  it("leads with the owner outcome and one plain code link after the shop links", () => {
    assert.match(html, /<h1 class="crom-h1">Connect your systems<\/h1>/);
    assert.match(html, new RegExp(`<p class="crom-lead">${STORY.lead}</p>`));
    assert.doesNotMatch(html, /holds no real data/);
    assert.equal((html.match(new RegExp(STORY.demo, "g")) ?? []).length, 0);
    const main = html.slice(html.indexOf("<main"), html.indexOf('<footer class="crom-footer">'));
    const links = main.match(/<a [^>]*>[^<]*<\/a>/g) ?? [];
    assert.deepEqual(links, [
      ...STORY.nav.map((item) => `<a href="${item.href}">${item.label}</a>`),
      '<a href="https://github.com/CromServices/api-webhook-sample">See the code on GitHub</a>',
    ]);
  });

  it("shows an empty shop and stock from the stored picture", () => {
    assert.match(html, /Made 0\. Arrived 0\./);
    assert.match(html, /Flat white: 12 on hand/);
    assert.match(html, /Long black: 12 on hand/);
    assert.match(html, /Banana bread: 12 on hand/);
    assert.doesNotMatch(html, /<script/);
    assert.doesNotMatch(html, /booking-sync|studio diary|Riley/);
  });

  it("keeps technical words out of the public copy (they live in the README)", () => {
    assert.doesNotMatch(visibleText(html), JARGON);
    assert.doesNotMatch(html, /id="developers"/);
    assert.doesNotMatch(html, /\d{4}-\d{2}-\d{2}T|\/admin|hmac|signature|payload|bearer/i);
  });

  it("serves the shop, stock, history and side-by-side pages in plain language", async () => {
    for (const path of ["/shop", "/stock", "/history", "/demo", "/demo?view=triage"]) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 200, path);
      const page = await res.text();
      assert.equal((page.match(/rel="stylesheet"/g) ?? []).length, 1, path);
      assert.doesNotMatch(page, /<style/, path);
      assert.doesNotMatch(page, /<script/, path);
      assert.doesNotMatch(visibleText(page), JARGON, path);
      assert.doesNotMatch(page, /\d{4}-\d{2}-\d{2}T|\/admin|hmac|signature|payload|bearer/i, path);
    }
    const demo = await (await fetch(`${baseUrl}/demo`)).text();
    assert.equal((demo.match(new RegExp(STORY.demo, "g")) ?? []).length, 1);
    assert.match(demo, />Before</);
    assert.match(demo, />After</);
    assert.match(demo, /No orders yet\./);
    const history = await (await fetch(`${baseUrl}/history`)).text();
    assert.match(history, /Nothing has happened yet\./);
    const triage = await (await fetch(`${baseUrl}/demo?view=triage`)).text();
    assert.match(triage, /Orders made: 0\. Orders that arrived in stock: 0\./);
    assert.match(triage, /Nothing out of place\./);
    assert.equal((triage.match(/Demo shop, not a real business/g) ?? []).length, 1);
    assert.doesNotMatch(triage, /1 never arrived|1 arrived twice|not from your shop|weren't copied across/);
  });

  it("keeps the public face clean (no city, state, postcode, names or price)", () => {
    assert.doesNotMatch(html, /Nathan|\bNate\b|Grok|Perth|\bWA\b|6162|\$\s?\d|\bAUD\b|\bprice|\bquote\b/i);
  });

  it("leaves /health as {ok:true}", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});
