/** Fixes from live call 3 (13 Oct): each case is a real (masked) turn or behaviour from that call. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import type WebSocket from "ws";
import { openCallLog } from "../src/phone/calllog.ts";
import { ASKED, LINES, SECOND_TRY, detectIntent, step, type FlowState } from "../src/phone/flow.ts";
import { lookupByName, lookupOrder } from "../src/phone/lookup.ts";
import { normaliseContact, readOrderNumber } from "../src/phone/normalise.ts";
import { sampleOrderSource } from "../src/phone/orders.ts";
import { callLogPage, maskDigits } from "../src/phone/page.ts";
import { CallSession } from "../src/phone/session.ts";
import { bridgeCall, mountTwilio, streamToken, twilioSignature } from "../src/phone/twilio.ts";
import type { VoiceEvents, VoiceProvider } from "../src/phone/voice/provider.ts";

const TOKEN = "test-twilio-token-not-real";
const SID = "CA00000000000000000000000000call3";
const FICTION = "0491570156"; // sample order contact (fiction)

function session(said: string[], log = openCallLog()) {
  const orders = sampleOrderSource();
  return new CallSession({
    telephony: { say: (x) => void said.push(x), ringOwner: async () => "no_answer", connectOwner() {}, hangUp() {} },
    sms: { async send() {} },
    lookup: (o, c) => lookupOrder(orders, o, c),
    lookupByName: (x) => lookupByName(orders, x),
    log,
    ownerTextTo: "0491570110",
  });
}

describe("call 3 fix 1: a bare hello is greeted again, not counted as a miss", () => {
  for (const hello of ["Hello?", "hello, who's this?", "Hi", "Yeah, hello?"]) {
    it(`"${hello}"`, async () => {
      const said: string[] = [];
      const s = session(said);
      await s.start(FICTION);
      await s.heard(hello);
      assert.equal(said[1], LINES.greetAgain);
      await s.heard("blah blah");
      assert.equal(said[2], LINES.askOrderAgain, "first real miss still gets the first-try wording");
    });
  }
  it("only on the first turn", async () => {
    const said: string[] = [];
    const s = session(said);
    await s.start(FICTION);
    await s.heard("um");
    await s.heard("Hello?");
    assert.notEqual(said.at(-1), LINES.greetAgain);
  });
});

describe("call 3 fix 2: stuttered numbers", () => {
  const cases: Array<[string, string]> = [
    ["A thousand, a thousand, thousand and forty-two", "1042"],
    ["a thousand, a thousand and forty-two", "1042"],
    ["one thousand one thousand forty two", "1042"],
    ["No, it's a thousand and forty-two", "1042"],
    ["two thousand and five", "2005"],
  ];
  for (const [text, n] of cases) it(`"${text}" -> ${n}`, () => assert.equal(readOrderNumber(text)?.number, n));
});

describe("call 3 fix 3: spoken emails", () => {
  const cases: Array<[string, string]> = [
    ["It's crom services at g mail dot com dot A U.", "cromservices@gmail.com.au"],
    ["my email is sam underscore b at outlook dot com", "sam_b@outlook.com"],
    ["yeah it's jo dash lee at bigpond dot net dot au", "jo-lee@bigpond.net.au"],
    ["that's mel at example dot com!", "mel@example.com"],
  ];
  for (const [text, e] of cases) {
    it(`"${text}"`, () => assert.deepEqual(normaliseContact(text), { kind: "email", value: e }));
  }
});

describe("call 3 fix 4 + hint: after a no-match, keep the order and offer the name lookup", () => {
  it("re-asks the contact for the same order, with the name + last-3 hint", async () => {
    const said: string[] = [];
    const s = session(said);
    await s.start(FICTION);
    await s.heard("one oh four two");
    await s.heard("0491 570 999");
    assert.equal(said.at(-1), LINES.noMatchHint("1042"));
    assert.match(said.at(-1)!, /first name and the last three digits/);
    assert.equal(s.phase, "ask_contact");
    await s.heard("0491 570 156");
    assert.ok(said.some((x) => /on its way/i.test(x)), said.join(" | "));
  });
  it("name + last 3 digits works from there", async () => {
    const orders = sampleOrderSource();
    const named = orders.all!().find((o) => o.number === "1042")!;
    const said: string[] = [];
    const s = session(said);
    await s.start(FICTION);
    await s.heard("one oh four two");
    await s.heard("0491 570 999");
    await s.heard(`It's ${named.name}, ${named.phone.slice(-3).split("").join(" ")}`);
    assert.ok(said.some((x) => /on its way/i.test(x)), said.join(" | "));
  });
  it("a different order number there starts that order", async () => {
    const said: string[] = [];
    const s = session(said);
    await s.start(FICTION);
    await s.heard("1099");
    await s.heard("0491 570 156");
    await s.heard("Sorry, 1042");
    assert.equal(said.at(-1), LINES.askContact);
  });
  it("second no-match hands over to Sam", async () => {
    const said: string[] = [];
    const s = session(said);
    await s.start(FICTION);
    await s.heard("1042");
    await s.heard("0491 570 999");
    await s.heard("0491 570 998");
    assert.ok(said.includes(LINES.handoffNoMatch));
  });
});

describe("order requests: the line never places orders, it passes them to Sam", () => {
  for (const t of [
    "Can you please get Sam to order me something else?",
    "I'd like to order a flat white",
    "can I place an order",
    "I want to put in a new order",
  ]) it(`"${t}" -> order_request`, () => assert.equal(detectIntent(t), "order_request"));
  for (const [t, i] of [["I want to change my order", "change"], ["where's my order", "status"], ["cancel my order", "change"]] as const) {
    it(`"${t}" stays ${i}`, () => assert.equal(detectIntent(t), i));
  }
  it("in the call: brief answer, logged as a request for Sam, then carries on", async () => {
    const said: string[] = [];
    const log = openCallLog();
    const s = session(said, log);
    await s.start(FICTION);
    await s.heard("Can you get Sam to order me something else?");
    assert.equal(said.at(-1), LINES.otherRequest);
    assert.equal(s.phase, "offer_message");
    await s.heard("no thanks");
    assert.equal(said.at(-1), "No problem. What's the order number?");
    await s.heard("one oh four two");
    await s.heard("0491 570 156");
    await s.heard("no thanks");
    assert.ok(log.list()[0]!.asked.includes(ASKED.orderRequest));
  });
  it("in a message left with the line: same answer, logged, and in Sam's text", async () => {
    let st: FlowState = {
      phase: "take_message", caller: FICTION, orderNumber: null, failedLookups: 0, misses: 0, silences: 0, asked: [],
      told: [], handedOver: true, handoffReason: "person", ownerAnswered: false, message: null, textedOwner: false,
    };
    const out = step(st, { type: "heard", text: "This didn't work very well. Also, can you please get Sam to order me something else? Okay, bye" });
    st = out.state;
    const sayLine = out.actions.find((a) => a.type === "say") as { text: string };
    assert.ok(sayLine.text.startsWith(LINES.orderRequest));
    assert.ok(st.asked.includes(ASKED.orderRequest));
    const text = out.actions.find((a) => a.type === "text_owner") as { body: string };
    assert.match(text.body, /want to place an order/);
    assert.ok(!out.actions.some((a) => a.type === "lookup"), "nothing ordered or changed");
  });
  it("in a Twilio voicemail: the transcription logs it as a request for Sam (signed only)", async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    const log = openCallLog();
    log.add({ ref: SID, caller: FICTION, asked: ["Where's my order"], told: [], handedOver: true, ownerAnswered: false, message: null, textedOwner: false, startedAt: "2026-10-13T02:03:00Z", endedAt: "2026-10-13T02:05:00Z" });
    const base = "https://phone.example.test";
    mountTwilio(app, null, { authToken: TOKEN, publicBaseUrl: base, provider: {} as VoiceProvider, callLog: log, lookup: () => ({ match: false, say: "" }) } as never);
    const server = app.listen(0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/phone/transcribed`;
    const body = { CallSid: SID, TranscriptionStatus: "completed", TranscriptionText: "Can you please get Sam to order me something else? Call me on 0491 570 156." };
    const unsigned = await fetch(url, { method: "POST", body: new URLSearchParams(body) });
    assert.equal(unsigned.status, 403);
    const r = await fetch(url, {
      method: "POST",
      headers: { "x-twilio-signature": twilioSignature(TOKEN, `${base}/phone/transcribed`, body) },
      body: new URLSearchParams(body),
    });
    assert.equal(r.status, 204);
    const entry = log.list()[0]!;
    assert.ok(entry.asked.includes(ASKED.orderRequest));
    const html = callLogPage(log.list());
    assert.match(html, /to place an order/i);
    assert.doesNotMatch(html, /0491 570 156/, "numbers in voicemail text are masked on the page");
    server.closeAllConnections();
    await new Promise<void>((res) => server.close(() => res()));
  });
  it("maskDigits keeps the last three", () => assert.equal(maskDigits("ring 0491 570 156 thanks"), "ring [number ending 156] thanks"));
});

describe("call 3 fixes 5 + 6: bridge turn taking", () => {
  class Sock extends EventEmitter {
    readonly OPEN = 1; readyState = 1; sent: any[] = []; echo = true;
    send(d: string) { const m = JSON.parse(d); this.sent.push(m); if (m.event === "mark" && this.echo) setImmediate(() => this.emit("message", Buffer.from(d))); }
    close() { this.readyState = 3; this.emit("close"); }
    twilio(m: unknown) { this.emit("message", Buffer.from(JSON.stringify(m))); }
  }
  function provider() {
    const p = { said: [] as string[], ev: null as VoiceEvents | null, name: "fake",
      async start(ev: VoiceEvents) { p.ev = ev; return { sendAudio() {}, async say(t: string) { p.said.push(t); ev.onAudio(Buffer.alloc(16000, 0xff).toString("base64")); }, async end() {} }; } };
    return p;
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const start = (ws: Sock) => ws.twilio({ event: "start", start: { callSid: SID, streamSid: "MZ", customParameters: { token: streamToken(TOKEN, SID), caller: "" } } });

  it("waits longer once the caller has started reading out a mobile number", async () => {
    const p = provider(); const ws = new Sock(); const orders = sampleOrderSource();
    bridgeCall(ws as unknown as WebSocket, { authToken: TOKEN, provider: p, callLog: openCallLog(), lookup: (o, c) => lookupOrder(orders, o, c), silenceMs: 60_000, joinMs: 30, digitJoinMs: 250, onAfter: () => {} });
    start(ws); await wait(40);
    p.ev!.onHeard("one oh four two"); await wait(80);
    assert.equal(p.said.at(-1), LINES.askContact);
    p.ev!.onHeard("It's uh, 0 4"); await wait(120); // a pause longer than joinMs
    assert.equal(p.said.at(-1), LINES.askContact, "did not answer mid-number");
    p.ev!.onHeard("9 1 5 7 0 1 5 6"); await wait(400);
    assert.ok(p.said.some((x) => /on its way/i.test(x)), p.said.join(" | "));
    ws.close();
  });
  it("an answer given over a question is answered at once (barge-in), not queued behind it", async () => {
    const p = provider(); const ws = new Sock(); ws.echo = false; // playback never "finishes" by itself
    const orders = sampleOrderSource();
    bridgeCall(ws as unknown as WebSocket, { authToken: TOKEN, provider: p, callLog: openCallLog(), lookup: (o, c) => lookupOrder(orders, o, c), silenceMs: 60_000, joinMs: 10, bargeIn: true, onAfter: () => {} });
    start(ws); await wait(30);
    p.ev!.onHeard("one oh four two"); await wait(120);
    assert.ok(ws.sent.some((m) => m.event === "clear"));
    assert.equal(p.said.at(-1), LINES.askContact, "replied within 120 ms, not after the 5 s playback");
    ws.close();
  });
  it("the second-try contact prompt is a question, so it can be talked over", () => {
    assert.match(SECOND_TRY.ask_contact!, /\?$/);
  });
});
