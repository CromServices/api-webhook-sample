/** Fixes from live call 7 (Nate, 13 Oct 18:40): outbound greeting gap, lost yes, dead air, waits, no-contact, bare name, noise. */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { openCallLog } from "../src/phone/calllog.ts";
import { LINES, bareName } from "../src/phone/flow.ts";
import { lookupByName, lookupOrder } from "../src/phone/lookup.ts";
import { sampleOrderSource } from "../src/phone/orders.ts";
import { CallSession } from "../src/phone/session.ts";
import { bridgeCall, digitsStillComing, isMobileNumber, streamToken } from "../src/phone/twilio.ts";
import type { VoiceEvents } from "../src/phone/voice/provider.ts";
import { XaiVoiceProvider } from "../src/phone/voice/xai.ts";

const TOKEN = "test-twilio-token-not-real";
const SID = "CA00000000000000000000000000call7";
function mulaw(sample: number) {
  const sign = sample < 0 ? 0x80 : 0; let s = Math.min(Math.abs(sample), 32635) + 0x84; let e = 7;
  for (let m = 0x4000; (s & m) === 0 && e > 0; m >>= 1) e -= 1;
  return ~(sign | (e << 4) | ((s >> (e + 3)) & 0x0f)) & 0xff;
}
const frame = (amp: number) => Buffer.from(Array.from({ length: 160 }, (_, i) => mulaw(i % 2 ? amp : -amp))).toString("base64");
const LOUD = frame(6000), SOFT = frame(260), QUIET = frame(12);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Sock extends EventEmitter {
  readonly OPEN = 1; readyState = 1; sent: any[] = []; echo = true;
  send(d: string) { const m = JSON.parse(d); this.sent.push(m); if (m.event === "mark" && this.echo) setImmediate(() => this.emit("message", Buffer.from(d))); }
  close() { this.readyState = 3; this.emit("close"); }
  twilio(m: unknown) { this.emit("message", Buffer.from(JSON.stringify(m))); }
  frames(b64: string, n: number) { for (let i = 0; i < n; i += 1) this.twilio({ event: "media", media: { track: "inbound", payload: b64 } }); }
}
function provider() {
  const p = { said: [] as string[], at: [] as number[], stops: 0, ev: null as VoiceEvents | null, name: "fake", release: null as null | (() => void), hold: false, flags: [] as boolean[],
    async start(ev: VoiceEvents) {
      p.ev = ev;
      return { sendAudio() {}, say(t: string, o?: { interruptible?: boolean }) { p.flags.push(!!o?.interruptible); p.said.push(t); p.at.push(Date.now()); ev.onAudio(QUIET); return p.hold ? new Promise<void>((r) => (p.release = r)) : Promise.resolve(); },
        stop() { p.stops += 1; p.release?.(); p.release = null; }, async end() {} };
    } };
  return p;
}
function bridge(extra: Record<string, unknown> = {}, params: Record<string, string> = {}) {
  const p = provider(); const ws = new Sock(); const orders = sampleOrderSource();
  bridgeCall(ws as unknown as WebSocket, { authToken: TOKEN, provider: p, callLog: openCallLog(), lookup: (o: string, c: string) => lookupOrder(orders, o, c), silenceMs: 60_000, bargeIn: true, onAfter: () => {}, ...extra } as never);
  ws.twilio({ event: "start", start: { callSid: SID, streamSid: "MZ", customParameters: { token: streamToken(TOKEN, SID), caller: "", ...params } } });
  return { p, ws };
}
async function until(f: () => boolean, ms = 4000) { const t = Date.now(); while (!f() && Date.now() - t < ms) await wait(20); }
async function feed(ws: Sock, b64: string, n: number) { for (let i = 0; i < n; i += 1) { ws.frames(b64, 1); await wait(20); } }
async function flow(turns: string[]) {
  const orders = sampleOrderSource(); const said: string[] = []; let rang = 0;
  const s = new CallSession({
    telephony: { say: (x) => void said.push(x), ringOwner: async () => { rang += 1; return "no_answer"; }, connectOwner() {}, hangUp() {} },
    sms: { async send() {} }, lookup: (o, c) => lookupOrder(orders, o, c), lookupByName: (x, n) => lookupByName(orders, x, n), log: openCallLog(), ownerTextTo: "0491570110",
  });
  await s.start("0491570110");
  for (const t of turns) if (s.phase !== "done") await s.heard(t);
  return { said, rang };
}
const MOBILE = "+61491570110"; // sample (fictional) mobile

describe("call 7 fix 1: outbound greets as soon as the call connects", () => {
  it("greeting goes out with no hello and no wait", async () => {
    const { p, ws } = bridge({}, { direction: "outbound", caller: MOBILE });
    await wait(30);
    assert.deepEqual(p.said, [LINES.greet]);
    p.ev!.onHeard("Hello?"); await wait(300);
    assert.deepEqual(p.said, [LINES.greet], "a hello over the greeting is not answered");
    ws.close();
  });
});

describe("call 7 fix 2: a yes said over the read-back is not lost", () => {
  let wss: WebSocketServer; let port = 0; let server: WebSocket | null = null;
  before(async () => {
    wss = new WebSocketServer({ port: 0 }); await new Promise((r) => wss.on("listening", r));
    port = (wss.address() as AddressInfo).port;
    wss.on("connection", (ws) => { server = ws; ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.type === "session.update") ws.send(JSON.stringify({ type: "session.updated" })); }); });
  });
  after(() => wss.close());
  it("a transcript landing after the settle wait is still delivered (once)", async () => {
    const heard: string[] = [];
    const v = await new XaiVoiceProvider({ apiKey: "test-key", url: `ws://127.0.0.1:${port}/v1/realtime`, settleMs: 30 }).start({ onAudio() {}, onHeard: (t) => heard.push(t) });
    server!.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "i7" }));
    await wait(120); // settle passed with no text
    assert.deepEqual(heard, []);
    server!.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "i7", transcript: "Yes." }));
    await wait(150);
    assert.deepEqual(heard, ["Yes."]);
    server!.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "i7", transcript: "Yes." }));
    await wait(150);
    assert.deepEqual(heard, ["Yes."], "not delivered twice");
    await v.end();
  });
  it("bridge: 'Yes' heard while the read-back is playing confirms the order", async () => {
    const { p, ws } = bridge({ endSilenceMs: 50 }); ws.echo = false;
    await wait(30);
    p.ev!.onHeard("a thousand and forty-two"); await until(() => p.said.length >= 2);
    assert.equal(p.said.at(-1), LINES.confirmOrder("1042"));
    p.hold = true; p.said.push("(read-back playing)");
    await feed(ws, LOUD, 3);
    p.ev!.onHeard("Yes."); await until(() => p.said.at(-1) === LINES.askContact, 1000);
    assert.equal(p.said.at(-1), LINES.askContact);
    ws.close();
  });
});

describe("call 7 fix 3: under 1 s after an interruption", () => {
  it("stopped, nothing heard -> re-said within 1 s of the stop", async () => {
    const { p, ws } = bridge(); ws.echo = false; p.hold = true;
    await wait(30);
    await feed(ws, LOUD, 3);
    const stopAt = Date.now();
    p.hold = false;
    while (p.said.length < 2 && Date.now() - stopAt < 2000) { ws.frames(QUIET, 1); await wait(20); }
    assert.equal(p.said.length, 2);
    assert.ok(p.at[1]! - stopAt < 1000, `re-said ${p.at[1]! - stopAt} ms after the stop`);
    ws.close();
  });
});

describe("call 7 fix 4: 2 s only while digits are expected", () => {
  it("digitsStillComing", () => {
    assert.equal(digitsStillComing("ask_order", "one oh"), true);
    assert.equal(digitsStillComing("ask_order", "a thousand and"), true);
    assert.equal(digitsStillComing("ask_order", "1042"), false);
    assert.equal(digitsStillComing("ask_order", "I'm not sure, but my name's Ari."), false);
    assert.equal(digitsStillComing("ask_contact", "0 4 9 1"), true);
    assert.equal(digitsStillComing("ask_contact", "I don't have an email or phone number handy."), false);
    assert.equal(digitsStillComing("ask_contact", "dom dot p at example dot com"), false);
    assert.equal(digitsStillComing("ask_name", "Ari one five"), true);
    assert.equal(digitsStillComing("ask_name", "Ari one five seven"), false);
    assert.equal(digitsStillComing("confirm_order", "Yes."), false);
    assert.equal(digitsStillComing("told", "no thanks"), false);
  });
  it("a non-digit answer at the contact ask gets the 1.2 s window, not 2 s", async () => {
    const { p, ws } = bridge();
    await wait(30);
    p.ev!.onHeard("1042");
    await until(() => p.said.length >= 2);
    p.ev!.onHeard("Yes.");
    await until(() => p.said.length >= 3);
    const t = Date.now(); p.ev!.onHeard("I'm not sure, but my name's Ari.");
    while (p.said.length < 4 && Date.now() - t < 3000) await wait(20);
    const gap = p.at.at(-1)! - t;
    assert.ok(gap >= 1150 && gap < 1500, `reply after ${gap} ms`);
    ws.close();
  });
});

describe("call 7 fixes 5 and 6: no contact / bare name -> name + last 3", () => {
  it("'I'm not sure, but my name's Ari.' -> asks only for the last three digits", async () => {
    const { said } = await flow(["1042", "Yes.", "I'm not sure, but my name's Ari."]);
    assert.equal(said.at(-1), LINES.askLast3("Ari"));
  });
  it("'I don't have an email or phone number handy.' (first try) -> name + last 3", async () => {
    const { said } = await flow(["1042", "Yes.", "I don't have an email or phone number handy."]);
    assert.equal(said.at(-1), LINES.noContact);
  });
  for (const t of ["I don't know.", "Not sure.", "No idea, sorry", "I haven't got it on me"]) {
    it(`'${t}' -> name + last 3`, async () => {
      const { said } = await flow(["1042", "Yes.", t]);
      assert.equal(said.at(-1), LINES.noContact);
    });
  }
  it("name then the 3 digits matches the confirmed order only", async () => {
    const ok = await flow(["1042", "Yes.", "My name's Priya.", "one five six"]);
    const orders = sampleOrderSource().all!();
    const o = orders.find((x) => x.number === "1042")!;
    const right = await flow(["1042", "Yes.", `My name's ${o.name}.`, o.phone.slice(-3).split("").join(" ")]);
    assert.equal(right.said.at(-1), LINES.anythingElse);
    assert.notEqual(ok.said.at(-1), LINES.anythingElse);
  });
  it("re-ask cap kept: call 7 replay ends with Sam, never loops", async () => {
    const { said, rang } = await flow(["1042", "Yes.", "I'm not sure, but my name's Ari.", "I don't know. My name is Ari.", "I don't have an email or phone number handy. My name is Ari."]);
    assert.equal(rang, 1, said.join(" | "));
    for (let i = 1; i < said.length; i += 1) assert.notEqual(said[i], said[i - 1]);
  });
  it("bareName", () => {
    assert.equal(bareName("I'm not sure, but my name's Ari."), "Ari");
    assert.equal(bareName("It's Dom"), "Dom");
    assert.equal(bareName("I'm not sure"), null);
    assert.equal(bareName("It's Dom, one five seven"), null);
    assert.equal(bareName("I'm just checking"), null);
  });
  it("a detour with a name in it still takes its own path", async () => {
    const { said } = await flow(["1042", "Yes.", "Hi, it's Priya, I want to talk to Sam"]);
    assert.ok(said.some((x) => /put you through/i.test(x)), said.join(" | "));
  });
});

describe("call 7 fix 7: higher interruption bar on mobiles", () => {
  it("isMobileNumber", () => {
    assert.equal(isMobileNumber("+61491570110"), true);
    assert.equal(isMobileNumber("0491 570 110"), true);
    assert.equal(isMobileNumber("+61862193046"), false);
  });
  it("mobile: a 60 ms noise burst doesn't stop the line; 160 ms of speech does", async () => {
    const { p, ws } = bridge({}, { caller: MOBILE }); ws.echo = false; p.hold = true;
    await wait(30); await feed(ws, QUIET, 20);
    await feed(ws, LOUD, 3); await feed(ws, QUIET, 5);
    assert.equal(p.stops, 0, "noise burst ignored");
    await feed(ws, LOUD, 8);
    assert.equal(p.stops, 1, "real speech stops it");
    ws.close();
  });
  it("mobile: a late xAI speech-start alone doesn't stop the line", async () => {
    const { p, ws } = bridge({}, { caller: MOBILE }); ws.echo = false; p.hold = true;
    await wait(30); await feed(ws, LOUD, 2); p.ev!.onSpeechStarted!();
    assert.equal(p.stops, 0);
    ws.close();
  });
  it("mobile: the line isn't marked interruptible to xAI (our VAD does the stopping)", async () => {
    const m = bridge({}, { caller: MOBILE }); await wait(30);
    const l = bridge({}, { caller: "+61862193046" }); await wait(30);
    assert.equal(m.p.flags[0], false);
    assert.equal(l.p.flags[0], true);
    m.ws.close(); l.ws.close();
  });
  it("landline: 40 ms of speech still stops the line (unchanged)", async () => {
    const { p, ws } = bridge({}, { caller: "+61862193046" }); ws.echo = false; p.hold = true;
    await wait(30); await feed(ws, LOUD, 2);
    assert.equal(p.stops, 1);
    ws.close();
  });
});
