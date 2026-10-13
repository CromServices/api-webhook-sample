/** Fixes from live call 4 (13 Oct): "pause and listen, then match". */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type WebSocket from "ws";
import { openCallLog } from "../src/phone/calllog.ts";
import { LINES } from "../src/phone/flow.ts";
import { lookupOrder } from "../src/phone/lookup.ts";
import { sampleOrderSource } from "../src/phone/orders.ts";
import { CallSession } from "../src/phone/session.ts";
import { bridgeCall, streamToken } from "../src/phone/twilio.ts";
import type { VoiceEvents } from "../src/phone/voice/provider.ts";

const TOKEN = "test-twilio-token-not-real";
const SID = "CA00000000000000000000000000call4";
class Sock extends EventEmitter {
  readonly OPEN = 1; readyState = 1; sent: any[] = [];
  send(d: string) { const m = JSON.parse(d); this.sent.push(m); if (m.event === "mark") setImmediate(() => this.emit("message", Buffer.from(d))); }
  close() { this.readyState = 3; this.emit("close"); }
  twilio(m: unknown) { this.emit("message", Buffer.from(JSON.stringify(m))); }
}
function provider() {
  const p = { said: [] as string[], at: [] as number[], ev: null as VoiceEvents | null, name: "fake",
    async start(ev: VoiceEvents) { p.ev = ev; return { sendAudio() {}, async say(t: string) { p.said.push(t); p.at.push(Date.now()); ev.onAudio(Buffer.alloc(160, 0xff).toString("base64")); }, async end() {} }; } };
  return p;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function bridge(extra: Record<string, unknown> = {}, direction = "inbound") {
  const p = provider(); const ws = new Sock(); const orders = sampleOrderSource();
  bridgeCall(ws as unknown as WebSocket, { authToken: TOKEN, provider: p, callLog: openCallLog(), lookup: (o: string, c: string) => lookupOrder(orders, o, c), silenceMs: 60_000, joinMs: 300, onAfter: () => {}, ...extra } as never);
  ws.twilio({ event: "start", start: { callSid: SID, streamSid: "MZ", customParameters: { token: streamToken(TOKEN, SID), caller: "", direction } } });
  return { p, ws };
}

describe("call 4 fix 1: a hello landing on the greeting is ignored (no restart)", () => {
  it("greeting is not cut or repeated", async () => {
    const { p, ws } = bridge({ bargeIn: true });
    await wait(30);
    p.ev!.onHeard("Hello?"); await wait(400);
    assert.deepEqual(p.said, [LINES.greet]);
    assert.ok(!ws.sent.some((m) => m.event === "clear"));
    p.ev!.onHeard("one oh four two"); await wait(600);
    assert.equal(p.said.at(-1), LINES.askContact);
    ws.close();
  });
});

describe("call 4 fix 2: outbound greets when the person first speaks, else after 6 s", () => {
  it("speech start -> greet shortly after", async () => {
    const { p, ws } = bridge({ helloWaitMs: 10_000 }, "outbound");
    await wait(30);
    assert.equal(p.said.length, 0);
    p.ev!.onSpeechStarted!(); await wait(900);
    assert.deepEqual(p.said, [LINES.greet]);
    p.ev!.onHeard("Hello?"); await wait(400);
    assert.deepEqual(p.said, [LINES.greet], "the hello itself is not answered");
    ws.close();
  });
  it("default wait is 6 s", () => {
    assert.match(readFileSync(new URL("../src/phone/twilio.ts", import.meta.url), "utf8"), /helloWaitMs \?\? 6000/);
  });
});

describe("call 4 fix 4 (revised after call 5): wait for real quiet, never a short join", () => {
  it("incomplete pieces still wait (no reply to 'a thousand and' or a part number)", async () => {
    const { p, ws } = bridge({ joinMs: 300, digitJoinMs: 600 });
    await wait(30);
    p.ev!.onHeard("a thousand and"); await wait(100);
    assert.deepEqual(p.said, [LINES.greet]);
    p.ev!.onHeard("forty-two"); await wait(500);
    assert.equal(p.said.at(-1), LINES.confirmOrder("1042"));
    ws.close();
  });
  it("tuned on the real call fixtures: every full answer counts as complete, partial numbers don't", async () => {
    const turns: Array<{ text: string; expect?: string }> = JSON.parse(readFileSync(new URL("./fixtures/call-turns.json", import.meta.url), "utf8"));
    const { readOrderNumber, normaliseContact } = await import("../src/phone/normalise.ts");
    for (const t of turns.filter((x) => x.expect === "number")) assert.ok(readOrderNumber(t.text), t.text);
    for (const t of turns.filter((x) => x.expect === "contact")) assert.ok(normaliseContact(t.text), t.text);
    for (const part of ["0 4 9 1", "It's uh, 0 4", "Zero"]) assert.equal(normaliseContact(part), null, part);
  });
});

describe("no-match wording: says it's the details, not hearing", () => {
  async function run(order: string) {
    const said: string[] = []; const orders = sampleOrderSource();
    const s = new CallSession({ telephony: { say: (x) => void said.push(x), ringOwner: async () => "no_answer", connectOwner() {}, hangUp() {} }, sms: { async send() {} }, lookup: (o, c) => lookupOrder(orders, o, c), log: openCallLog(), ownerTextTo: "0491570110" });
    await s.start("0491570110"); await s.heard(order); await s.heard("0491 570 999");
    return said.at(-1)!;
  }
  it("clear wording", async () => assert.match(await run("one oh four two"), /^That contact doesn't match the details on order one-oh-four-two\./));
  it("same wording whether or not the order exists (reveals nothing)", async () => {
    assert.equal((await run("one oh nine nine")).replace("one-oh-nine-nine", "N"), (await run("one oh four two")).replace("one-oh-four-two", "N"));
  });
});

describe("call 4 fix 5: voicemail text from the line's own speech-to-text", () => {
  it("recording callback -> transcribe -> message + order request in the log; no Twilio transcription", async () => {
    const express = (await import("express")).default;
    const { mountTwilio, twilioSignature } = await import("../src/phone/twilio.ts");
    const { ASKED } = await import("../src/phone/flow.ts");
    const app = express(); app.use(express.urlencoded({ extended: false }));
    const log = openCallLog();
    log.add({ ref: SID, caller: "0491570110", asked: ["Where's my order"], told: [], handedOver: true, ownerAnswered: false, message: null, textedOwner: false, startedAt: "2026-10-13T02:30:00Z", endedAt: "2026-10-13T02:31:00Z" });
    const base = "https://phone.example.test";
    let got = 0;
    const api = mountTwilio(app, null, {
      authToken: TOKEN, accountSid: "AC0", publicBaseUrl: base, callLog: log, lookup: () => ({ match: false, say: "" }), provider: {} as never,
      fetchImpl: (async () => new Response(new Uint8Array([1, 2, 3]))) as never,
      transcribeVoicemail: async (wav: Buffer) => { got = wav.length; return "Please get Sam to order me something else."; },
    } as never);
    void api;
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const body = { CallSid: SID, RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE1", RecordingDuration: "9", RecordingStatus: "completed" };
    const r = await fetch(`http://127.0.0.1:${port}/phone/recording`, { method: "POST", headers: { "x-twilio-signature": twilioSignature(TOKEN, `${base}/phone/recording`, body) }, body: new URLSearchParams(body) });
    assert.equal(r.status, 204);
    await wait(50);
    assert.equal(got, 3);
    const e = log.list()[0]!;
    assert.equal(e.message, "Please get Sam to order me something else.");
    assert.ok(e.asked.includes(ASKED.orderRequest));
    // Voicemail TwiML no longer asks Twilio to transcribe.
    assert.doesNotMatch(readFileSync(new URL("../src/phone/twilio.ts", import.meta.url), "utf8"), /transcribe="true"/);
    server.closeAllConnections(); await new Promise<void>((res) => server.close(() => res()));
  });
});
