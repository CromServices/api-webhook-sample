/** Fixes from live call 5 (13 Oct): stop when the caller talks, wait for real quiet, new requests -> message offer. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { openCallLog } from "../src/phone/calllog.ts";
import { LINES, detectIntent } from "../src/phone/flow.ts";
import { lookupOrder } from "../src/phone/lookup.ts";
import { normaliseAuPhone, normaliseContact } from "../src/phone/normalise.ts";
import { sampleOrderSource } from "../src/phone/orders.ts";
import { CallSession } from "../src/phone/session.ts";
import { bridgeCall, streamToken } from "../src/phone/twilio.ts";
import type { VoiceEvents } from "../src/phone/voice/provider.ts";

const TOKEN = "test-twilio-token-not-real";
const SID = "CA00000000000000000000000000call5";
const LOUD = Buffer.alloc(160, 0x80).toString("base64"); // μ-law 0x80 = loudest positive
const QUIET = Buffer.alloc(160, 0xff).toString("base64"); // μ-law 0xff = 0
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Sock extends EventEmitter {
  readonly OPEN = 1; readyState = 1; sent: any[] = []; echo = true;
  send(d: string) { const m = JSON.parse(d); this.sent.push(m); if (m.event === "mark" && this.echo) setImmediate(() => this.emit("message", Buffer.from(d))); }
  close() { this.readyState = 3; this.emit("close"); }
  twilio(m: unknown) { this.emit("message", Buffer.from(JSON.stringify(m))); }
  frames(b64: string, n: number) { for (let i = 0; i < n; i += 1) this.twilio({ event: "media", media: { track: "inbound", payload: b64 } }); }
}
/** Provider whose lines keep "playing" until stop() (or release). */
function provider() {
  const p = { said: [] as string[], at: [] as number[], stops: [] as number[], ev: null as VoiceEvents | null, name: "fake", release: null as null | (() => void), hold: false,
    async start(ev: VoiceEvents) {
      p.ev = ev;
      return {
        sendAudio() {},
        say(t: string) { p.said.push(t); p.at.push(Date.now()); ev.onAudio(Buffer.alloc(160, 0xff).toString("base64")); return p.hold ? new Promise<void>((r) => (p.release = r)) : Promise.resolve(); },
        stop() { p.stops.push(Date.now()); p.release?.(); p.release = null; },
        async end() {},
      };
    } };
  return p;
}
function bridge(extra: Record<string, unknown> = {}) {
  const p = provider(); const ws = new Sock(); const orders = sampleOrderSource();
  bridgeCall(ws as unknown as WebSocket, { authToken: TOKEN, provider: p, callLog: openCallLog(), lookup: (o: string, c: string) => lookupOrder(orders, o, c), silenceMs: 60_000, bargeIn: true, onAfter: () => {}, ...extra } as never);
  ws.twilio({ event: "start", start: { callSid: SID, streamSid: "MZ", customParameters: { token: streamToken(TOKEN, SID), caller: "" } } });
  return { p, ws };
}

describe("barge-in on ANY line: the line stops the instant the caller talks", () => {
  for (const kind of ["greeting (statement + question)", "an answer"]) {
    it(`stops ${kind}: Twilio clear + response cancelled, measured`, async () => {
      const { p, ws } = bridge({ endSilenceMs: 100 });
      if (kind === "an answer") {
        await wait(30); p.ev!.onHeard("one oh four two"); await wait(200);
        ws.echo = false; p.hold = true; p.ev!.onHeard("0491 570 156"); await wait(200);
        assert.ok(p.said.some((x) => /on its way/i.test(x)));
      } else { ws.echo = false; p.hold = true; await wait(30); }
      const before = ws.sent.filter((m) => m.event === "clear").length;
      const t = Date.now();
      ws.frames(LOUD, 2); // 40 ms of speech
      await wait(5);
      const clears = ws.sent.filter((m) => m.event === "clear").length;
      assert.equal(clears, before + 1, "Twilio playback cleared");
      assert.equal(p.stops.length, 1, "TTS response cancelled");
      const ms = p.stops[0]! - t;
      assert.ok(ms < 50, `stopped ${ms} ms after the 2nd voiced frame arrived`);
      ws.close();
    });
  }
  it("a single click (one loud frame) doesn't stop the line", async () => {
    const { p, ws } = bridge(); ws.echo = false; p.hold = true; await wait(30);
    ws.frames(LOUD, 1); ws.frames(QUIET, 1); await wait(5);
    assert.equal(p.stops.length, 0);
    ws.close();
  });
});

describe("never start speaking while the caller is talking", () => {
  it("waits for 1.2 s of quiet on the caller's audio before replying", async () => {
    const { p, ws } = bridge({ endSilenceMs: 300 });
    await wait(30);
    const n = p.said.length;
    p.ev!.onHeard("a thousand and forty-two");
    for (let i = 0; i < 6; i += 1) { ws.frames(LOUD, 2); await wait(100); } // still talking for 600 ms
    assert.equal(p.said.length, n, "no reply while voiced frames keep coming");
    await wait(400);
    assert.equal(p.said.at(-1), LINES.confirmOrder("1042"));
    ws.close();
  });
  it("default quiet windows: 1.2 s normal, 2 s while reading digits", async () => {
    const { p, ws } = bridge();
    await wait(30);
    const t = Date.now(); p.ev!.onHeard("one oh four two");
    while (p.said.length < 2 && Date.now() - t < 3000) await wait(20);
    const gap = p.at.at(-1)! - t;
    assert.ok(gap >= 1150 && gap < 1500, `normal reply after ${gap} ms`);
    const t2 = Date.now(); p.ev!.onHeard("0 4 9 1");
    await wait(1500); assert.equal(p.said.length, 2, "no reply to a part number at 1.5 s");
    p.ev!.onHeard("5 7 0 1 5 6");
    while (!p.said.some((x) => /on its way/i.test(x)) && Date.now() - t2 < 6000) await wait(20);
    assert.ok(p.said.some((x) => /on its way/i.test(x)));
    ws.close();
  });
  it("the 'are you still there' nudge never fires while the caller is talking", async () => {
    const { p, ws } = bridge({ silenceMs: 200, endSilenceMs: 100 });
    await wait(30);
    for (let i = 0; i < 8; i += 1) { ws.frames(LOUD, 2); await wait(60); }
    assert.ok(!p.said.some((x) => x.startsWith(LINES.stillThere)));
    ws.close();
  });
});

describe("turn 10: duplicated digit runs", () => {
  it("speech-to-text resending a longer piece keeps one copy", async () => {
    const { p, ws } = bridge({ endSilenceMs: 60, digitJoinMs: 200 });
    await wait(30); p.ev!.onHeard("one oh four two"); await wait(150);
    p.ev!.onHeard("It's 0 4 9 1"); await wait(50); p.ev!.onHeard("It's 0 4 9 1 5 7 0 1 5 6"); await wait(400);
    assert.ok(p.said.some((x) => /on its way/i.test(x)), p.said.join(" | "));
    ws.close();
  });
  it("a repeated start in one turn is de-duplicated", () => {
    assert.equal(normaliseAuPhone("It's 0 4 9 1 It's 0 4 9 1 5 7 0 1 5 6"), "0491570156");
    assert.equal(normaliseAuPhone("0491 0491 570 156"), "0491570156");
    assert.deepEqual(normaliseContact("It's 0 4 9 1 It's 0 4 9 1 5 7 0 1 5 6"), { kind: "phone", value: "0491570156" });
  });
});

function session(said: string[]) {
  const orders = sampleOrderSource();
  return new CallSession({ telephony: { say: (x) => void said.push(x), ringOwner: async () => "no_answer", connectOwner() {}, hangUp() {} }, sms: { async send() {} }, lookup: (o, c) => lookupOrder(orders, o, c), log: openCallLog(), ownerTextTo: "0491570110" });
}

describe("turns 21-32: new orders, buying, non-café requests -> offer a message", () => {
  const call5 = [
    "Yeah, can I raise another order?",
    "No, I want to create a new one.",
    "I want to buy something else from Sam's store.",
    "I want five coffees, a pizza.",
    "Maybe two dogs.",
    "I've got some plumbing out the back too.",
  ];
  for (const t of call5) it(`"${t}" -> order_request`, () => assert.equal(detectIntent(t), "order_request"));
  it('"send me to Sam so I can create another order" -> Sam', () => assert.notEqual(detectIntent("Yeah, best to send me to Sam so I can create another order."), "none"));
  it('"check another order" is still a lookup', () => assert.notEqual(detectIntent("can I check another order"), "order_request"));

  it("after a status (told phase): the offer, not a lookup; yes -> voicemail", async () => {
    const said: string[] = []; const s = session(said);
    await s.start("0491570110"); await s.heard("one oh four two"); await s.heard("0491 570 156");
    await s.heard("Yeah, can I raise another order?");
    assert.equal(said.at(-1), LINES.otherRequest);
    await s.heard("Yes please");
    assert.ok(said.includes(LINES.handoffMessage));
  });
  it("silence after the offer -> voicemail", async () => {
    const said: string[] = []; const s = session(said);
    await s.start("0491570110"); await s.heard("I want five coffees and two dogs");
    assert.equal(said.at(-1), LINES.otherRequest);
    await s.silence();
    assert.ok(said.includes(LINES.handoffMessage));
  });
  it("no -> back to the current question", async () => {
    const said: string[] = []; const s = session(said);
    await s.start("0491570110"); await s.heard("one oh four two");
    await s.heard("can someone do some plumbing for me");
    await s.heard("nah");
    assert.equal(said.at(-1), "No problem. What's the mobile or email on the order?");
    await s.heard("0491 570 156");
    assert.ok(said.some((x) => /on its way/i.test(x)));
  });
  it("a refusal never has a re-prompt glued on", async () => {
    const said: string[] = []; const s = session(said);
    await s.start("0491570110"); await s.heard("Do you sell gift cards for birthdays?");
    assert.equal(said.at(-1), LINES.offTopic);
    assert.doesNotMatch(said.at(-1)!, /order number\?/);
  });
});

describe("turn 15 + handover wording", () => {
  it("silence nudge is one short question (no stacked 'sorry, I missed that')", async () => {
    const said: string[] = []; const s = session(said);
    await s.start("0491570110"); await s.heard("one oh four two"); await s.silence();
    assert.equal(said.at(-1), "Are you still there? What's the mobile or email on the order?");
  });
  it("no line ever blames hearing", () => {
    for (const v of Object.values(LINES)) if (typeof v === "string") assert.doesNotMatch(v, /trouble hearing|can't hear|hard to hear/i);
  });
});
