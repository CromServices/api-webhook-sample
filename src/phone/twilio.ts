import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Express, Request, Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { CallLog } from "./calllog.ts";
import { OWNER_NAME } from "./flow.ts";
import type { LookupResult } from "./lookup.ts";
import { normaliseAuPhone } from "./normalise.ts";
import { CallSession, TEXTS_NOT_SET_UP, type TextSender } from "./session.ts";
import type { VoiceProvider, VoiceSession } from "./voice/provider.ts";

/**
 * Twilio side of the phone line.
 *   POST /phone/voice      call comes in -> <Connect><Stream> to our websocket, then <Redirect> to /phone/after
 *   WS   /phone/stream     Twilio Media Streams <-> voice provider, driving the call flow
 *   POST /phone/after      stream closed -> ring the owner, take a voicemail, or hang up
 *   POST /phone/dialled    owner's phone result -> voicemail if no answer
 *   POST /phone/recorded   <Record> finished (caller hung up / pressed key)
 *   POST /phone/recording  recording ready (status callback) -> voicemail link in the log
 * Every POST needs a valid X-Twilio-Signature. With no TWILIO_AUTH_TOKEN they all answer 403.
 * The line only reads orders; nothing here can change one.
 */
export type TwilioOptions = {
  authToken?: string;
  accountSid?: string;
  /** e.g. https://crom-phone-line-sample.fly.dev (no trailing slash). */
  publicBaseUrl?: string;
  /** Owner's phone for live handover. Unset = voicemail only. */
  ownerNumber?: string;
  ringSeconds?: number;
  provider: VoiceProvider;
  callLog: CallLog;
  lookup: (orderNumber: string, contact: string, who: string) => Promise<LookupResult> | LookupResult;
  sms?: TextSender;
  ownerTextTo?: string;
  /** Silence before the flow is nudged. */
  silenceMs?: number;
  /** Test hook: fetch for voicemail audio. */
  fetchImpl?: typeof fetch;
  /** Print a timed transcript to the server log (test calls only). */
  transcriptLog?: boolean;
};

export function twilioSignature(authToken: string, url: string, params: Record<string, unknown>): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + String(params[k] ?? ""))
      .join("");
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function streamToken(authToken: string, callSid: string): string {
  return createHmac("sha256", authToken).update(`stream:${callSid}`).digest("hex");
}

export function voicemailKey(authToken: string, ref: string): string {
  return createHmac("sha256", authToken).update(`voicemail:${ref}`).digest("hex").slice(0, 32);
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const twiml = (res: Response, body: string) =>
  res.status(200).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);

const VOICE = 'voice="Polly.Olivia-Neural" language="en-AU"';

/** How each call left the stream: decides what /phone/after does. */
type After = "handover" | "hangup";

export function mountTwilio(app: Express, server: Server | null, opts: TwilioOptions) {
  const token = opts.authToken ?? "";
  const base = (opts.publicBaseUrl ?? "").replace(/\/$/, "");
  const after = new Map<string, After>();
  const fetchImpl = opts.fetchImpl ?? fetch;

  function signed(req: Request, res: Response): boolean {
    if (!token || !base) {
      res.status(403).type("text").send("Forbidden");
      return false;
    }
    const sig = req.header("x-twilio-signature") ?? "";
    const expected = twilioSignature(token, base + req.originalUrl, (req.body ?? {}) as Record<string, unknown>);
    if (!sig || !same(sig, expected)) {
      res.status(403).type("text").send("Forbidden");
      return false;
    }
    return true;
  }

  const voicemail = (callSid: string) => {
    return (
      `<Say ${VOICE}>${xml(`${OWNER_NAME} can't come to the phone. Please leave a message after the tone, then hang up.`)}</Say>` +
      `<Record maxLength="120" timeout="5" playBeep="true" action="${xml(`${base}/phone/recorded`)}" method="POST"` +
      ` recordingStatusCallback="${xml(`${base}/phone/recording`)}" recordingStatusCallbackMethod="POST"` +
      ` recordingStatusCallbackEvent="completed"/>` +
      `<Hangup/>`
    );
  };

  app.post("/phone/voice", (req, res) => {
    if (!signed(req, res)) return;
    const callSid = String(req.body.CallSid ?? "");
    const from = String(req.body.From ?? "");
    const wsUrl = base.replace(/^http/, "ws") + "/phone/stream";
    twiml(
      res,
      `<Connect><Stream url="${xml(wsUrl)}">` +
        `<Parameter name="token" value="${streamToken(token, callSid)}"/>` +
        `<Parameter name="caller" value="${xml(from)}"/>` +
        `</Stream></Connect>` +
        `<Redirect method="POST">${xml(`${base}/phone/after`)}</Redirect>`,
    );
  });

  app.post("/phone/after", (req, res) => {
    if (!signed(req, res)) return;
    const callSid = String(req.body.CallSid ?? "");
    const next = after.get(callSid);
    after.delete(callSid);
    if (next !== "handover") return twiml(res, "<Hangup/>");
    if (opts.ownerNumber) {
      return twiml(
        res,
        `<Dial timeout="${opts.ringSeconds ?? 20}" action="${xml(`${base}/phone/dialled`)}" method="POST">${xml(opts.ownerNumber)}</Dial>`,
      );
    }
    twiml(res, voicemail(callSid));
  });

  app.post("/phone/dialled", (req, res) => {
    if (!signed(req, res)) return;
    const callSid = String(req.body.CallSid ?? "");
    if (String(req.body.DialCallStatus) === "completed") {
      opts.callLog.update(callSid, { ownerAnswered: true });
      return twiml(res, "<Hangup/>");
    }
    opts.callLog.update(callSid, { ownerAnswered: false });
    twiml(res, voicemail(callSid));
  });

  app.post("/phone/recorded", (req, res) => {
    if (!signed(req, res)) return;
    const callSid = String(req.body.CallSid ?? "");
    const secs = Number(req.body.RecordingDuration ?? 0);
    if (!req.body.RecordingUrl || secs < 1) opts.callLog.update(callSid, { voicemail: "none" });
    twiml(res, "<Hangup/>");
  });

  app.post("/phone/recording", (req, res) => {
    if (!signed(req, res)) return;
    const callSid = String(req.body.CallSid ?? "");
    const url = String(req.body.RecordingUrl ?? "");
    const secs = Number(req.body.RecordingDuration ?? 0);
    if (String(req.body.RecordingStatus ?? "completed") === "completed" && url && secs >= 1) {
      opts.callLog.update(callSid, { voicemail: "left", recordingUrl: url, recordingSeconds: secs });
    } else {
      opts.callLog.update(callSid, { voicemail: "none" });
    }
    res.status(204).end();
  });

  /** Owner-only voicemail audio, proxied so the recording never needs to be public. Mounted behind /calls auth. */
  async function sendVoicemail(key: string, res: Response): Promise<void> {
    const entry = token ? opts.callLog.list().find((e) => e.ref && voicemailKey(token, e.ref) === key) : undefined;
    if (!entry?.recordingUrl || !opts.accountSid || !entry.recordingUrl.startsWith("https://api.twilio.com/")) {
      res.status(404).type("text").send("Not found");
      return;
    }
    const r = await fetchImpl(`${entry.recordingUrl}.mp3`, {
      headers: { authorization: "Basic " + Buffer.from(`${opts.accountSid}:${token}`).toString("base64") },
    });
    if (!r.ok) {
      res.status(502).type("text").send("Voicemail not available yet.");
      return;
    }
    res.set("cache-control", "no-store").type("audio/mpeg").send(Buffer.from(await r.arrayBuffer()));
  }

  if (server) attachStream(server);

  function attachStream(srv: Server) {
    const wss = new WebSocketServer({ noServer: true });
    srv.on("upgrade", (req: IncomingMessage, socket, head) => {
      if ((req.url ?? "").split("?")[0] !== "/phone/stream" || !token) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => bridge(ws));
    });
  }

  function bridge(ws: WebSocket) {
    bridgeCall(ws, {
      ...opts,
      authToken: token,
      onAfter: (callSid, what) => after.set(callSid, what),
    });
  }

  return {
    sendVoicemail,
    voicemailHref: (ref: string) => (token ? `/calls/voicemail/${voicemailKey(token, ref)}` : ""),
    bridge,
    attach: attachStream,
  };
}

export type BridgeOptions = TwilioOptions & {
  authToken: string;
  onAfter: (callSid: string, what: After) => void;
};

/** One phone call: Twilio media stream <-> voice provider <-> call flow. */
export function bridgeCall(ws: WebSocket, opts: BridgeOptions): void {
  let streamSid = "";
  let callSid = "";
  let voice: VoiceSession | null = null;
  let session: CallSession | null = null;
  let closedByUs = false;
  let ended = false;
  let markN = 0;
  const marks = new Map<string, () => void>();
  let silenceTimer: NodeJS.Timeout | null = null;
  let chain: Promise<void> = Promise.resolve();
  let voiceStarted = 0;
  const silenceMs = opts.silenceMs ?? 8000;
  // Off by default. PHONE_TRANSCRIPT_LOG=1 prints a timed transcript for test calls only.
  const trace = opts.transcriptLog ?? false;
  let t0 = 0;
  let firstAudio = false;
  const note = (who: string, text: string) => {
    if (trace) console.log(`call-trace ${callSid} +${((Date.now() - t0) / 1000).toFixed(2)}s ${who}: ${text}`);
  };

  const sendTwilio = (msg: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const clearSilence = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = null;
  };
  const armSilence = () => {
    clearSilence();
    if (ended || session?.phase === "done") return;
    silenceTimer = setTimeout(() => run((s) => s.silence()), silenceMs);
  };
  const run = (fn: (s: CallSession) => Promise<void>) => {
    chain = chain.then(async () => {
      if (!session || ended) return;
      clearSilence();
      try {
        await fn(session);
      } catch (err) {
        console.error("phone line: flow error", (err as Error).message);
      }
      if (session.phase === "done") finish();
      else armSilence();
    });
    return chain;
  };

  const finish = () => {
    if (ended) return;
    ended = true;
    clearSilence();
    for (const done of marks.values()) done();
    marks.clear();
    const secs = voiceStarted ? Math.round((Date.now() - voiceStarted) / 1000) : 0;
    if (callSid && secs) opts.callLog.update(callSid, { voiceSeconds: secs });
    void voice?.end();
    closedByUs = true;
    if (ws.readyState === ws.OPEN) ws.close();
  };

  const playMark = (bytes: number) =>
    new Promise<void>((resolve) => {
      const name = `m${++markN}`;
      // Fallback in case the mark echo never comes back: audio length + 3 s.
      const t = setTimeout(() => {
        marks.delete(name);
        resolve();
      }, Math.ceil(bytes / 8) + 3000);
      marks.set(name, () => {
        clearTimeout(t);
        resolve();
      });
      sendTwilio({ event: "mark", streamSid, mark: { name } });
    });

  ws.on("message", async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.event) {
      case "start": {
        const params = msg.start?.customParameters ?? {};
        t0 = Date.now();
        callSid = String(msg.start?.callSid ?? "");
        streamSid = String(msg.start?.streamSid ?? msg.streamSid ?? "");
        const good = callSid && typeof params.token === "string" && same(params.token, streamToken(opts.authToken, callSid));
        if (!good) {
          ended = true;
          ws.close();
          return;
        }
        let bytes = 0;
        try {
          voice = await opts.provider.start({
            onAudio(b64) {
              bytes += Math.floor((b64.length * 3) / 4);
              if (!firstAudio) {
                firstAudio = true;
                note("line", "(first audio sent to caller)");
              }
              sendTwilio({ event: "media", streamSid, media: { payload: b64 } });
            },
            onHeard(text) {
              note("caller", text);
              void run((s) => s.heard(text));
            },
            onSpeechStarted() {
              clearSilence();
            },
            onError(m) {
              console.error("phone line: voice error", m);
            },
          });
        } catch (err) {
          console.error("phone line: voice start failed", (err as Error).message);
          // No voice: send the caller straight to the owner / voicemail.
          opts.onAfter(callSid, "handover");
          ended = true;
          closedByUs = true;
          ws.close();
          return;
        }
        voiceStarted = Date.now();
        session = new CallSession({
          ref: callSid,
          telephony: {
            say: async (text) => {
              bytes = 0;
              note("line", text);
              await voice!.say(text);
              await playMark(bytes);
            },
            ringOwner: async () => {
              opts.onAfter(callSid, "handover");
              return "handed_to_phone";
            },
            connectOwner: async () => {},
            hangUp: async () => {
              opts.onAfter(callSid, "hangup");
            },
          },
          sms: opts.sms ?? TEXTS_NOT_SET_UP,
          ownerTextTo: opts.ownerTextTo ?? "",
          lookup: (o, c) => opts.lookup(o, c, callSid),
          log: opts.callLog,
        });
        const caller = String(params.caller ?? "");
        void run((s) => s.start(normaliseAuPhone(caller) ?? caller));
        return;
      }
      case "media":
        if (msg.media?.track && msg.media.track !== "inbound") return;
        if (typeof msg.media?.payload === "string") voice?.sendAudio(msg.media.payload);
        return;
      case "mark": {
        const name = String(msg.mark?.name ?? "");
        marks.get(name)?.();
        marks.delete(name);
        return;
      }
      case "stop":
        callerGone();
        return;
    }
  });
  ws.on("close", () => callerGone());

  function callerGone() {
    if (closedByUs || ended) return;
    void chain.then(async () => {
      if (ended) return;
      if (session && session.phase !== "done") await session.hungUp().catch(() => {});
      finish();
    });
  }
}
