import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { createApp } from "../src/app.ts";
import { openCallLog, type CallLog } from "../src/phone/calllog.ts";
import { lookupOrder } from "../src/phone/lookup.ts";
import { sampleOrderSource } from "../src/phone/orders.ts";
import { callLogPage } from "../src/phone/page.ts";
import { LINES } from "../src/phone/flow.ts";
import { bridgeCall, streamToken, twilioSignature, voicemailKey } from "../src/phone/twilio.ts";
import { StubProvider, type VoiceEvents, type VoiceProvider } from "../src/phone/voice/provider.ts";
import { XaiVoiceProvider } from "../src/phone/voice/xai.ts";
import { SCRIPTS } from "./phone-scripts.ts";

const TOKEN = "test-twilio-token-not-real";
const BASE = "https://phone.example.test";
const SID = "CA0000000000000000000000000000test";

/** A voice provider that "speaks" by emitting one audio chunk and hears whatever the test says. */
class FakeProvider implements VoiceProvider {
  said: string[] = [];
  events: VoiceEvents | null = null;
  constructor(readonly name = "fake") {}
  async start(events: VoiceEvents) {
    this.events = events;
    return {
      sendAudio: () => {},
      say: async (text: string) => {
        this.said.push(text);
        events.onAudio(Buffer.alloc(160, 0xff).toString("base64"));
      },
      end: async () => {},
    };
  }
  hear(text: string) {
    this.events!.onHeard(text);
  }
}

/** Stand-in for Twilio's end of the media stream: echoes marks like Twilio does after playback. */
class FakeTwilioSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: any[] = [];
  closed = false;
  send(data: string) {
    const msg = JSON.parse(data);
    this.sent.push(msg);
    if (msg.event === "mark") setImmediate(() => this.emit("message", Buffer.from(JSON.stringify(msg))));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }
  twilio(msg: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 15));

async function callThroughBridge(
  provider: FakeProvider | VoiceProvider,
  script: (typeof SCRIPTS)[number],
  log: CallLog,
  callSid = SID,
  extra: Record<string, unknown> = {},
  params: Record<string, string> = {},
) {
  const ws = new FakeTwilioSocket();
  const afters: string[] = [];
  const orders = sampleOrderSource();
  bridgeCall(ws as unknown as WebSocket, {
    authToken: TOKEN,
    provider,
    callLog: log,
    lookup: (o, c) => lookupOrder(orders, o, c),
    silenceMs: 60_000,
    joinMs: 5,
    ...extra,
    onAfter: (_sid, what) => afters.push(what),
  });
  ws.twilio({ event: "connected" });
  ws.twilio({
    event: "start",
    streamSid: "MZtest",
    start: { callSid, streamSid: "MZtest", customParameters: { token: streamToken(TOKEN, callSid), caller: script.caller, ...params } },
  });
  await settle();
  for (const turn of script.turns) {
    if (ws.closed) break;
    if ("heard" in turn && provider instanceof FakeProvider) provider.hear(turn.heard);
    await settle();
  }
  if (!ws.closed) {
    ws.twilio({ event: "stop" });
    await settle();
  }
  return { ws, afters };
}

describe("phone line: Twilio signature", () => {
  it("matches Twilio's documented example", () => {
    // Example from Twilio's security docs.
    const sig = twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", {
      CallSid: "CA1234567890ABCDE",
      Caller: "+12349013030",
      Digits: "1234",
      From: "+12349013030",
      To: "+18005551212",
    });
    assert.equal(sig, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });
});

describe("phone line: Twilio webhooks", () => {
  let server: Server;
  let url: string;
  let closedServer: Server;
  let closedUrl: string;
  let log: CallLog;
  const appProvider = new FakeProvider();
  const fetched: string[] = [];

  const post = async (base: string, p: string, body: Record<string, string>, sign = true, token = TOKEN) => {
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (sign) headers["x-twilio-signature"] = twilioSignature(token, BASE + p, body);
    return fetch(base + p, { method: "POST", headers, body: new URLSearchParams(body).toString() });
  };

  before(async () => {
    log = openCallLog(path.join(mkdtempSync(path.join(tmpdir(), "crom-voice-")), "calls.json"));
    const app = createApp({
      webhookSecret: "x",
      phoneLine: {
        viewUser: "sam",
        viewPassword: "pw",
        callLog: log,
        twilio: {
          authToken: TOKEN,
          accountSid: "ACtest",
          publicBaseUrl: BASE,
          provider: appProvider,
          fetchImpl: (async (u: string) => {
            fetched.push(String(u));
            return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
          }) as typeof fetch,
        },
      },
    });
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    app.attachPhone(server);
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const closed = createApp({ webhookSecret: "x", phoneLine: { twilio: { provider: new FakeProvider() } } });
    closedServer = await new Promise((resolve) => {
      const s = closed.listen(0, "127.0.0.1", () => resolve(s));
    });
    closedUrl = `http://127.0.0.1:${(closedServer.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
    closedServer.close();
  });

  it("fails closed (403) when TWILIO_AUTH_TOKEN is not set", async () => {
    const r = await post(closedUrl, "/phone/voice", { CallSid: SID, From: "+61491570156" });
    assert.equal(r.status, 403);
  });

  it("refuses a missing or wrong signature", async () => {
    assert.equal((await post(url, "/phone/voice", { CallSid: SID }, false)).status, 403);
    assert.equal((await post(url, "/phone/voice", { CallSid: SID }, true, "wrong-token")).status, 403);
  });

  it("answers a signed call with a stream to our websocket, then /phone/after", async () => {
    const r = await post(url, "/phone/voice", { CallSid: SID, From: "+61491570156" });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /<Connect><Stream url="wss:\/\/phone\.example\.test\/phone\/stream">/);
    assert.match(body, new RegExp(`<Parameter name="token" value="${streamToken(TOKEN, SID)}"/>`));
    assert.match(body, /<Redirect method="POST">https:\/\/phone\.example\.test\/phone\/after<\/Redirect>/);
  });

  it("hangs up after the stream unless the flow asked for a handover", async () => {
    const r = await post(url, "/phone/after", { CallSid: "CAnothing" });
    assert.match(await r.text(), /<Hangup\/>/);
  });

  it("rejects a media stream with a bad token", async () => {
    const ws = new WebSocket(url.replace("http", "ws") + "/phone/stream");
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ event: "start", start: { callSid: SID, streamSid: "MZ", customParameters: { token: "nope" } } }));
    await new Promise((r) => ws.on("close", r));
    assert.ok(true);
  });

  it("runs a call over a real websocket: ask for Sam, stream closes, voicemail TwiML", async () => {
    const ws = new WebSocket(url.replace("http", "ws") + "/phone/stream");
    const got: any[] = [];
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      got.push(m);
      if (m.event === "mark") ws.send(JSON.stringify(m));
    });
    await new Promise((r) => ws.on("open", r));
    const sid = "CAvoicemail0000000000000000000001";
    ws.send(
      JSON.stringify({
        event: "start",
        streamSid: "MZ1",
        start: { callSid: sid, streamSid: "MZ1", customParameters: { token: streamToken(TOKEN, sid), caller: "+61491570737" } },
      }),
    );
    await settle();
    assert.ok(got.some((m) => m.event === "media" && m.streamSid === "MZ1"), "caller hears audio");
    const closed = new Promise((r) => ws.on("close", r));
    appProvider.hear("Can I just talk to someone please?");
    await closed;
    const entry = log.list().find((e) => e.ref === sid)!;
    assert.equal(entry.handedOver, true);
    assert.equal(entry.caller, "0491570737");
    const next = await post(url, "/phone/after", { CallSid: sid });
    const twiml = await next.text();
    assert.match(twiml, /<Record [^>]*recordingStatusCallback="https:\/\/phone\.example\.test\/phone\/recording"/);
    assert.ok(appProvider.said.some((l) => /leave a message after the tone/.test(l)), "voicemail prompt in the line's own voice");
    assert.doesNotMatch(twiml, /<Say/, "no second voice");
  });

  it("logs voicemail from Twilio's recording callback and serves it to the owner only", async () => {
    log.add({
      caller: "0855501234",
      asked: ["To talk to Sam"],
      told: ["Put through to Sam"],
      handedOver: true,
      ownerAnswered: false,
      textedOwner: false,
      textStatus: "not_set_up",
      message: null,
      ref: "CAvm",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    } as any);
    const handed = await post(url, "/phone/after", { CallSid: "CAvm" });
    assert.match(await handed.text(), /<Hangup\/>/); // not registered by a bridge in this test
    const rec = await post(url, "/phone/recording", {
      CallSid: "CAvm",
      RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/REtest",
      RecordingDuration: "7",
      RecordingStatus: "completed",
    });
    assert.equal(rec.status, 204);
    const entry = log.list().find((e) => e.ref === "CAvm")!;
    assert.equal(entry.voicemail, "left");

    const page = await fetch(url + "/calls", { headers: { authorization: "Basic " + Buffer.from("sam:pw").toString("base64") } });
    const html = await page.text();
    assert.match(html, /Passed to Sam/);
    assert.match(html, /left a message/);
    assert.match(html, /Text to Sam.*Not set up yet/s);
    assert.doesNotMatch(html, /CAvm|REtest|api\.twilio\.com/, "no ids or provider links on screen or in the page");
    const href = `/calls/voicemail/${voicemailKey(TOKEN, "CAvm")}`;
    assert.match(html, new RegExp(href));

    assert.equal((await fetch(url + href)).status, 401, "voicemail needs the owner login");
    const audio = await fetch(url + href, { headers: { authorization: "Basic " + Buffer.from("sam:pw").toString("base64") } });
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("content-type"), "audio/mpeg");
    assert.deepEqual(fetched, ["https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/REtest.mp3"]);
  });

  it("an unsigned recording callback changes nothing", async () => {
    const r = await post(url, "/phone/recording", { CallSid: "CAvm", RecordingUrl: "https://evil.example/x", RecordingDuration: "9" }, false);
    assert.equal(r.status, 403);
  });
});

describe("phone line: the five scenarios through the media bridge", () => {
  for (const script of SCRIPTS) {
    it(script.name, async () => {
      const provider = new FakeProvider();
      const log = openCallLog();
      const { ws, afters } = await callThroughBridge(provider, script, log);
      assert.ok(provider.said.length >= 2, "the flow spoke through the provider");
      assert.ok(ws.sent.some((m) => m.event === "media"), "audio went back to Twilio");
      assert.ok(ws.closed, "the stream was closed");
      const entry = log.list()[0]!;
      assert.equal(entry.ref, SID);
      if (script.name === "happy path") {
        assert.equal(entry.handedOver, false);
        assert.deepEqual(afters, ["hangup"]);
        assert.match(provider.said.join(" "), /on its way/i);
      } else {
        assert.equal(entry.handedOver, true, `${script.name} is passed to Sam`);
        assert.deepEqual(afters, ["handover"]);
      }
      // The line never says an order changed.
      assert.doesNotMatch(provider.said.join(" "), /\b(cancelled|changed|updated) (it|your order)\b/i);
    });
  }

  it("a caller hanging up mid-call is logged", async () => {
    const provider = new FakeProvider();
    const log = openCallLog();
    await callThroughBridge(provider, { ...SCRIPTS[0]!, turns: [] }, log);
    assert.equal(log.list().length, 1);
  });

  it("a bad stream token never reaches the provider", async () => {
    const provider = new FakeProvider();
    const ws = new FakeTwilioSocket();
    bridgeCall(ws as unknown as WebSocket, {
      authToken: TOKEN,
      provider,
      callLog: openCallLog(),
      lookup: () => ({ match: false, say: "" }),
      onAfter: () => {},
    });
    ws.twilio({ event: "start", start: { callSid: SID, streamSid: "MZ", customParameters: { token: "forged" } } });
    await settle();
    assert.equal(provider.events, null);
    assert.ok(ws.closed);
  });
});

describe("phone line: provider swap", () => {
  it("another provider runs the same flows and logs the same calls", async () => {
    class OtherProvider extends FakeProvider {}
    for (const script of SCRIPTS) {
      const a = openCallLog();
      const b = openCallLog();
      const pa = new FakeProvider("xai-like");
      const pb = new OtherProvider("retell-like");
      await callThroughBridge(pa, script, a);
      await callThroughBridge(pb, script, b);
      assert.deepEqual(pb.said, pa.said, script.name);
      const strip = (e: any) => ({ ...e, startedAt: 0, endedAt: 0, voiceSeconds: 0 });
      assert.deepEqual(strip(b.list()[0]), strip(a.list()[0]), script.name);
    }
  });

  it("the not-yet-set-up stub provider sends the caller straight to Sam", async () => {
    const log = openCallLog();
    const { afters, ws } = await callThroughBridge(new StubProvider("grok-sip"), SCRIPTS[0]!, log);
    assert.deepEqual(afters, ["handover"]);
    assert.ok(ws.closed);
  });
});

describe("phone line: xAI provider protocol (mock server)", () => {
  let wss: WebSocketServer;
  let port: number;
  const fromClient: any[] = [];
  let serverSocket: WebSocket | null = null;
  let auth = "";

  before(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss.on("listening", r));
    port = (wss.address() as AddressInfo).port;
    wss.on("connection", (ws, req) => {
      auth = String(req.headers.authorization ?? "");
      serverSocket = ws;
      ws.on("message", (d) => {
        const m = JSON.parse(d.toString());
        fromClient.push(m);
        if (m.type === "session.update") ws.send(JSON.stringify({ type: "session.updated", session: m.session }));
        if (m.type === "conversation.item.create" && m.item?.type === "force_message") {
          ws.send(JSON.stringify({ type: "response.created", response: { id: "r1" } }));
          ws.send(JSON.stringify({ type: "response.output_audio.delta", response_id: "r1", delta: "AAAA" }));
          ws.send(JSON.stringify({ type: "response.done", response: { id: "r1", usage: { input_tokens: 1, output_tokens: 2 } } }));
        }
      });
    });
  });
  after(() => wss.close());

  it("asks for μ-law both ways, speaks lines verbatim, drops the model's own replies", async () => {
    const audio: string[] = [];
    const heard: string[] = [];
    const provider = new XaiVoiceProvider({ apiKey: "test-key", url: `ws://127.0.0.1:${port}/v1/realtime`, settleMs: 5 });
    const session = await provider.start({ onAudio: (a) => audio.push(a), onHeard: (t) => heard.push(t) });
    assert.equal(auth, "Bearer test-key");
    const update = fromClient.find((m) => m.type === "session.update");
    assert.equal(update.session.audio.input.format.type, "audio/pcmu");
    assert.equal(update.session.audio.output.format.type, "audio/pcmu");
    assert.equal(update.session.turn_detection.type, "server_vad");

    await session.say("Thanks for calling.");
    const forced = fromClient.find((m) => m.item?.type === "force_message");
    assert.equal(forced.item.content[0].text, "Thanks for calling.");
    assert.equal(forced.item.interruptible, false);
    assert.ok(!fromClient.some((m) => m.type === "response.create"), "force_message needs no response.create");
    assert.deepEqual(audio, ["AAAA"]);

    session.sendAudio("//8=");
    serverSocket!.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "order" }));
    serverSocket!.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "i1" }));
    serverSocket!.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: " order 1042 " }));
    serverSocket!.send(JSON.stringify({ type: "response.created", response: { id: "r2" } }));
    serverSocket!.send(JSON.stringify({ type: "response.output_audio.delta", response_id: "r2", delta: "BBBB" }));
    await settle();
    await settle();
    assert.deepEqual(heard, ["order 1042"], "one turn, the final transcript only");
    assert.deepEqual(audio, ["AAAA"], "model's own reply never reaches the caller");
    assert.ok(fromClient.some((m) => m.type === "response.cancel"));
    assert.ok(fromClient.some((m) => m.type === "input_audio_buffer.append" && m.audio === "//8="));
    await session.end();
  });
});

describe("phone line: call log page", () => {
  it("shows the voicemail link only for entries with a recording", () => {
    const base = {
      caller: "0491570158",
      asked: ["To talk to Sam"],
      told: ["Put through to Sam"],
      handedOver: true,
      ownerAnswered: false,
      textedOwner: false,
      message: null,
      startedAt: "2026-10-10T01:00:00Z",
      endedAt: "2026-10-10T01:01:00Z",
    } as any;
    const html = callLogPage(
      [
        { ...base, ref: "a", voicemail: "left", recordingUrl: "https://api.twilio.com/x", recordingSeconds: 12 },
        { ...base, ref: "b", voicemail: "none" },
      ],
      "Australia/Sydney",
      { voicemailHref: (r) => `/calls/voicemail/k-${r}` },
    );
    assert.match(html, /Listen \(12 sec\)/);
    assert.match(html, /hung up before leaving a message/);
    assert.equal((html.match(/\/calls\/voicemail\//g) ?? []).length, 1);
    assert.doesNotMatch(html, /0491570158|0491 570 158/);
  });
});

describe("phone line: turn taking", () => {
  it("joins speech pieces split by a pause into one answer", async () => {
    const provider = new FakeProvider();
    const log = openCallLog();
    const ws = new FakeTwilioSocket();
    const orders = sampleOrderSource();
    bridgeCall(ws as unknown as WebSocket, {
      authToken: TOKEN, provider, callLog: log, lookup: (o, c) => lookupOrder(orders, o, c),
      silenceMs: 60_000, joinMs: 40, onAfter: () => {},
    });
    ws.twilio({ event: "start", start: { callSid: SID, streamSid: "MZ", customParameters: { token: streamToken(TOKEN, SID), caller: "" } } });
    await settle();
    provider.hear("one oh four two");
    await new Promise((r) => setTimeout(r, 100));
    provider.hear("0 4 9 1");
    provider.events!.onSpeechStarted!();
    await new Promise((r) => setTimeout(r, 60));
    provider.hear("5 7 0 1 5 6");
    await new Promise((r) => setTimeout(r, 120));
    assert.match(provider.said.join(" "), /on its way/i, provider.said.join(" | "));
    ws.close();
  });

  it("outbound calls wait for hello before the greeting", async () => {
    const provider = new FakeProvider();
    const ws = new FakeTwilioSocket();
    bridgeCall(ws as unknown as WebSocket, {
      authToken: TOKEN, provider, callLog: openCallLog(), lookup: () => ({ match: false, say: "" }),
      silenceMs: 60_000, joinMs: 5, helloWaitMs: 10_000, onAfter: () => {},
    });
    ws.twilio({ event: "start", start: { callSid: SID, streamSid: "MZ", customParameters: { token: streamToken(TOKEN, SID), caller: "", direction: "outbound" } } });
    await settle();
    assert.equal(provider.said.length, 0, "silent until hello");
    provider.hear("Hello?");
    await settle();
    assert.equal(provider.said[0], LINES.greet);
    assert.equal(provider.said.length, 1, "the hello is not taken as an answer");
    ws.close();
  });

  it("outbound calls greet anyway after the wait if nobody speaks", async () => {
    const provider = new FakeProvider();
    const ws = new FakeTwilioSocket();
    bridgeCall(ws as unknown as WebSocket, {
      authToken: TOKEN, provider, callLog: openCallLog(), lookup: () => ({ match: false, say: "" }),
      silenceMs: 60_000, helloWaitMs: 30, onAfter: () => {},
    });
    ws.twilio({ event: "start", start: { callSid: SID, streamSid: "MZ", customParameters: { token: streamToken(TOKEN, SID), caller: "", direction: "outbound" } } });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(provider.said[0], LINES.greet);
    ws.close();
  });
});
