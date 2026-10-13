/** Fixes from live call 6 (13 Oct): dead air after a barge-in, quiet window from real speech end, quiet talkers. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { openCallLog } from "../src/phone/calllog.ts";
import { LINES } from "../src/phone/flow.ts";
import { lookupOrder } from "../src/phone/lookup.ts";
import { sampleOrderSource } from "../src/phone/orders.ts";
import { bridgeCall, streamToken } from "../src/phone/twilio.ts";
import type { VoiceEvents } from "../src/phone/voice/provider.ts";

const TOKEN = "test-twilio-token-not-real";
const SID = "CA00000000000000000000000000call6";
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
  const p = { said: [] as string[], at: [] as number[], stops: 0, ev: null as VoiceEvents | null, name: "fake", release: null as null | (() => void), hold: false,
    async start(ev: VoiceEvents) {
      p.ev = ev;
      return { sendAudio() {}, say(t: string) { p.said.push(t); p.at.push(Date.now()); ev.onAudio(QUIET); return p.hold ? new Promise<void>((r) => (p.release = r)) : Promise.resolve(); },
        stop() { p.stops += 1; p.release?.(); p.release = null; }, async end() {} };
    } };
  return p;
}
function bridge(extra: Record<string, unknown> = {}) {
  const p = provider(); const ws = new Sock(); const orders = sampleOrderSource();
  bridgeCall(ws as unknown as WebSocket, { authToken: TOKEN, provider: p, callLog: openCallLog(), lookup: (o: string, c: string) => lookupOrder(orders, o, c), silenceMs: 60_000, bargeIn: true, onAfter: () => {}, ...extra } as never);
  ws.twilio({ event: "start", start: { callSid: SID, streamSid: "MZ", customParameters: { token: streamToken(TOKEN, SID), caller: "" } } });
  return { p, ws };
}
/** Feed n × 20 ms frames in real time. */
async function feed(ws: Sock, b64: string, n: number) { for (let i = 0; i < n; i += 1) { ws.frames(b64, 1); await wait(20); } }

describe("call 6 fix 1: no dead air after a barge-in", () => {
  it("stopped and nothing heard -> the stopped line is said again", async () => {
    const { p, ws } = bridge({ resayMs: 150 }); ws.echo = false; p.hold = true;
    await wait(30);
    assert.equal(p.said[0], LINES.greet);
    await feed(ws, LOUD, 3); // a cough over the greeting
    assert.equal(p.stops, 1);
    p.hold = false;
    await feed(ws, QUIET, 70); // 1.4 s of quiet
    assert.equal(p.said.filter((x) => x === LINES.greet).length, 2, p.said.join(" | "));
    ws.close();
  });
  it("not when he actually said something", async () => {
    const { p, ws } = bridge({ resayMs: 150, endSilenceMs: 100 }); ws.echo = false; p.hold = true;
    await wait(30); await feed(ws, LOUD, 3); p.hold = false;
    p.ev!.onHeard("one oh four two"); await feed(ws, QUIET, 60);
    assert.equal(p.said.filter((x) => x === LINES.greet).length, 1);
    assert.equal(p.said.at(-1), LINES.askContact);
    ws.close();
  });
});

describe("call 6 fix 2: the quiet window starts at the end of his real speech", () => {
  it("text arriving 1.3 s after he stopped is answered straight away (not +1.2 s)", async () => {
    const { p, ws } = bridge();
    await wait(30);
    await feed(ws, LOUD, 20); // 0.4 s of speech
    await feed(ws, QUIET, 65); // 1.3 s quiet before the text lands
    const t = Date.now(); p.ev!.onHeard("a thousand and forty-two");
    while (p.said.length < 2 && Date.now() - t < 2000) await wait(10);
    const gap = p.at.at(-1)! - t;
    assert.equal(p.said.at(-1), LINES.confirmOrder("1042"));
    assert.ok(gap >= 90 && gap < 300, `replied ${gap} ms after the text`);
    ws.close();
  });
  it("still never replies while he is talking", async () => {
    const { p, ws } = bridge();
    await wait(30);
    p.ev!.onHeard("a thousand and forty-two");
    await feed(ws, LOUD, 60); // keeps talking 1.2 s
    assert.equal(p.said.length, 1);
    await feed(ws, QUIET, 70);
    assert.equal(p.said.at(-1), LINES.confirmOrder("1042"));
    ws.close();
  });
});

describe("call 6 fix 3: quiet speech", () => {
  it("a soft voice (level ~260, under the old fixed 400) still stops the line once the floor is known", async () => {
    const { p, ws } = bridge(); ws.echo = false; p.hold = true;
    await wait(30); await feed(ws, QUIET, 30); // learn the line's noise floor
    await feed(ws, SOFT, 3);
    assert.equal(p.stops, 1);
    ws.close();
  });
  it("background hiss alone doesn't", async () => {
    const { p, ws } = bridge(); ws.echo = false; p.hold = true;
    await wait(30); await feed(ws, QUIET, 60);
    assert.equal(p.stops, 0);
    ws.close();
  });
  it("a late speech-to-text 'speech started' for a sound that ended before the line began doesn't stop it", async () => {
    const { p, ws } = bridge(); ws.echo = false; p.hold = true;
    await wait(30); await feed(ws, QUIET, 40); // 0.8 s since any voice
    p.ev!.onSpeechStarted!();
    assert.equal(p.stops, 0);
    ws.close();
  });
});
