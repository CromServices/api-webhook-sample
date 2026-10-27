import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { chatStep, TEXTS, type ChatPhase } from "../../src/whatsapp/flow.ts";
import { mountWhatsApp, twiml } from "../../src/whatsapp/routes.ts";
import { inboxPage, maskNumber } from "../../src/whatsapp/page.ts";
import { sampleOrderSource } from "../../src/phone/orders.ts";
import { twilioSignature } from "../../src/phone/twilio.ts";

const src = sampleOrderSource();
const ARI = "whatsapp:+61491570156"; // phone on order 1042
const OTHER = "whatsapp:+61491570199";

function run(from: string, msgs: string[]) {
  let phase: ChatPhase = { kind: "idle" };
  const all: ReturnType<typeof chatStep>[] = [];
  for (const m of msgs) { const r = chatStep(src, phase, from, m); phase = r.phase; all.push(r); }
  return all;
}

test("order owner's own number gets the status straight away", () => {
  const [r] = run(ARI, ["Hi, where's order 1042?"]);
  assert.match(r!.replies[0]!, /Order 1042 \(Long black\): Your order is on its way/);
});

test("ask for the number first when none is given", () => {
  const [a, b] = run(ARI, ["where's my order", "it's #1042"]);
  assert.equal(a!.replies[0], TEXTS.askOrder);
  assert.match(b!.replies[0]!, /on its way/);
});

test("another number must give the order email; right email -> status", () => {
  const [a, b] = run(OTHER, ["order 1045", "dom.p@example.com"]);
  assert.equal(a!.replies[0], TEXTS.askEmail);
  assert.match(b!.replies[0]!, /ready to collect/);
});

test("wrong email or unknown order: same answer, no status, goes to Sam", () => {
  const wrong = run(OTHER, ["order 1045", "jess.t@example.com"])[1]!;
  const unknown = run(OTHER, ["order 9999", "dom.p@example.com"])[1]!;
  assert.equal(wrong.replies[0], TEXTS.noMatch);
  assert.equal(unknown.replies[0], TEXTS.noMatch);
  assert.equal(wrong.effects[0]!.type, "handoff");
  for (const r of [wrong, unknown]) assert.doesNotMatch(r.replies.join(" "), /ready|collect|Flat white/i);
});

test("someone else's order is never shown to the wrong number", () => {
  const [r] = run(ARI, ["order 1045"]);
  assert.equal(r!.replies[0], TEXTS.askEmail);
});

test("non-email reply gets one retry then hands over", () => {
  const r = run(OTHER, ["order 1042", "dunno", "still dunno"]);
  assert.equal(r[1]!.replies[0], TEXTS.emailRetry);
  assert.equal(r[2]!.replies[0], TEXTS.noMatch);
});

test("enquiry capture: name and need saved as a lead", () => {
  const r = run(OTHER, ["Do you do catering?", "I'm priya", "Coffee for 12, Friday 9am"]);
  assert.equal(r[0]!.replies[0], TEXTS.leadName);
  assert.match(r[1]!.replies[0]!, /Thanks Priya/);
  assert.deepEqual(r[2]!.effects[0], { type: "lead", lead: { name: "Priya", need: "Coffee for 12, Friday 9am", from: OTHER } });
});

test("detours: hours, location, person, change, new order, hello", () => {
  assert.equal(run(OTHER, ["what time do you open?"])[0]!.replies[0], TEXTS.hours);
  assert.equal(run(OTHER, ["what's your address"])[0]!.replies[0], TEXTS.where);
  assert.equal(run(OTHER, ["can I talk to Sam"])[0]!.replies[0], TEXTS.person);
  assert.equal(run(ARI, ["I want to cancel order 1042"])[0]!.replies[0], TEXTS.change);
  assert.equal(run(OTHER, ["can i order a flat white"])[0]!.replies[0], TEXTS.newOrder());
  assert.equal(run(OTHER, ["hello"])[0]!.replies[0], TEXTS.welcome);
});

test("customer copy has no bot wording", () => {
  const all = Object.values(TEXTS).map((t) => (typeof t === "function" ? (t as (a: string) => string)("X") : t)).join(" ");
  assert.doesNotMatch(all, /\b(bot|AI|automated|assistant|robot|GPT)\b/i);
});

test("twiml escapes and inbox masks numbers", () => {
  assert.equal(twiml(["a<b & 'c'"]), '<?xml version="1.0" encoding="UTF-8"?><Response><Message>a&lt;b &amp; &apos;c&apos;</Message></Response>');
  assert.equal(maskNumber(OTHER), "•••• ••• 199");
  const html = inboxPage([{ at: 0, kind: "lead", lead: { name: "<x>", need: "n", from: OTHER } }]);
  assert.match(html, /&lt;x&gt;/);
  assert.doesNotMatch(html, /491570199/);
});

async function server(opts: Parameters<typeof mountWhatsApp>[1]) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  mountWhatsApp(app, opts);
  const s = app.listen(0);
  await new Promise((r) => s.once("listening", r));
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

test("inbound webhook: signed -> TwiML reply; unsigned/badly signed/no token -> 403", async () => {
  const base = "https://wa.example.test";
  const { s, url } = await server({ authToken: "tok", publicBaseUrl: base });
  try {
    const params = { From: ARI, Body: "where is 1042" };
    const sig = twilioSignature("tok", base + "/whatsapp/inbound", params);
    const ok = await fetch(url + "/whatsapp/inbound", { method: "POST", headers: { "x-twilio-signature": sig, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /<Message>Order 1042 \(Long black\)/);
    const bad = await fetch(url + "/whatsapp/inbound", { method: "POST", headers: { "x-twilio-signature": "nope", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
    assert.equal(bad.status, 403);
    const none = await fetch(url + "/whatsapp/inbound", { method: "POST", body: new URLSearchParams(params) });
    assert.equal(none.status, 403);
  } finally { s.close(); }
  const closed = await server({});
  try {
    const r = await fetch(closed.url + "/whatsapp/inbound", { method: "POST", headers: { "x-twilio-signature": "x" }, body: new URLSearchParams({ From: ARI }) });
    assert.equal(r.status, 403);
    assert.equal((await fetch(closed.url + "/whatsapp/inbox")).status, 404);
  } finally { closed.s.close(); }
});

test("inbox needs login; rate limit per sender", async () => {
  let t = 0;
  const { s, url } = await server({ authToken: "tok", publicBaseUrl: "https://x", viewUser: "sam", viewPassword: "pw", perSenderPerMinute: 2, now: () => t });
  try {
    assert.equal((await fetch(url + "/whatsapp/inbox")).status, 401);
    const ok = await fetch(url + "/whatsapp/inbox", { headers: { authorization: "Basic " + Buffer.from("sam:pw").toString("base64") } });
    assert.equal(ok.status, 200);
    const send = async () => {
      const p = { From: OTHER, Body: "hello" };
      const r = await fetch(url + "/whatsapp/inbound", { method: "POST", headers: { "x-twilio-signature": twilioSignature("tok", "https://x/whatsapp/inbound", p), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(p) });
      return r.text();
    };
    assert.match(await send(), /<Message>/);
    assert.match(await send(), /<Message>/);
    assert.doesNotMatch(await send(), /<Message>/);
  } finally { s.close(); }
});

test("new-order reply: no website line unless the shop sets an https link", () => {
  const plain = chatStep(src, { kind: "idle" }, OTHER, "can i order a flat white").replies[0]!;
  assert.doesNotMatch(plain, /website|order at/i);
  const linked = chatStep(src, { kind: "idle" }, OTHER, "can i order a flat white", { orderUrl: "https://gannetstreetkitchen.example/order" }).replies[0]!;
  assert.match(linked, /order at https:\/\/gannetstreetkitchen\.example\/order\./);
  const bad = chatStep(src, { kind: "idle" }, OTHER, "can i order a flat white", { orderUrl: "javascript:alert(1)" }).replies[0]!;
  assert.equal(bad, plain);
});

test("reply-time promise is a shop setting with a safe default", () => {
  const done = (cfg?: { replyPromise?: string }) =>
    chatStep(src, { kind: "lead_need", name: "Priya" }, OTHER, "coffee for 12", cfg).replies[0]!;
  assert.match(done(), /reply on this chat as soon as they can\.$/);
  assert.doesNotMatch(done(), /same day/);
  assert.match(done({ replyPromise: "within 2 hours" }), /reply on this chat within 2 hours\.$/);
  assert.match(done({ replyPromise: "   " }), /as soon as they can\.$/);
});

test("Sam's page says updates were sent straight away (no machine wording)", () => {
  const html = inboxPage([]);
  assert.match(html, /Order updates were sent straight away\./);
  assert.doesNotMatch(html, /automatic/i);
});
