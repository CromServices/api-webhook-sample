import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";
import { THEME_CSS_URL } from "../src/landing.ts";

const PIN = "https://cdn.jsdelivr.net/gh/CromServices/crom-shared@v1.0.2/";

/** Visible text only: drop tags (and so every URL inside them). */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

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
  });

  it("leads with the owner outcome and ends with one plain code link", () => {
    assert.match(html, /<h1 class="crom-h1">Connect your systems<\/h1>/);
    assert.match(
      html,
      /<p class="crom-lead">Your website and business tools pass details to each other on their own, and only genuine requests get through\.<\/p>/,
    );
    assert.match(html, /holds no real data/);
    const main = html.slice(html.indexOf("<main"), html.indexOf('<footer class="crom-footer">'));
    const links = main.match(/<a [^>]*>[^<]*<\/a>/g) ?? [];
    assert.deepEqual(links, [
      '<a href="https://github.com/CromServices/api-webhook-sample">See the code on GitHub</a>',
    ]);
  });

  it("keeps technical words out of the public copy (they live in the README)", () => {
    assert.doesNotMatch(
      visibleText(html),
      /express|hmac|sha-?256|signature|x-signature|webhook|endpoint|\bapi\b|json|\/health|curl|header/i,
    );
    assert.doesNotMatch(html, /id="developers"/);
  });

  it("shows sample bookings moving from the website into the studio diary", () => {
    assert.match(html, /id="booking-sync"/);
    assert.match(html, /From the website to the diary/);
    assert.match(html, /A new booking shows up in the studio diary on its own/);
    assert.match(html, /Nothing here is a real client/);
    assert.match(html, />Website</);
    assert.match(html, />Studio diary</);
    assert.match(html, /In the diary/);
    assert.match(html, /On its way/);
    assert.match(html, /On the website/);
    assert.match(html, /Not there yet/);
    assert.match(html, /Latest: Riley, Tue 2:00 pm, is on its way\./);
    assert.equal((html.match(/data-step="/g) ?? []).length, 4);
    assert.match(html, /data-step="2"/);
    assert.match(html, /data-step="1"/);
    assert.match(html, /data-step="0"/);
    assert.match(html, /setInterval\(tick, 1800\)/);
    assert.match(html, /prefers-reduced-motion: reduce/);
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
