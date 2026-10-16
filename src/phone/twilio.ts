import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Express, Request, Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { CallLog } from "./calllog.ts";
import { OWNER_NAME } from "./flow.ts";
import type { LookupResult } from "./lookup.ts";
import { normaliseAuPhone, readOrderNumber, spokenDigits } from "./normalise.ts";
import { ASKED, HELLO_ONLY, ORDER_REQUEST } from "./flow.ts";
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
  lookupByName?: (text: string, orderNumber?: string | null) => Promise<LookupResult> | LookupResult;
  sms?: TextSender;
  ownerTextTo?: string;
  /** Silence before the flow is nudged. */
  silenceMs?: number;
  /** Test hook: fetch for voicemail audio. */
  fetchImpl?: typeof fetch;
  /** Flag: let the caller talk over the line when it asks a question. */
  bargeIn?: boolean;
  /** Flag: after a read-back, silence repeats the yes/no question. */
  confirmReask?: boolean;
  /** Join caller speech pieces closer than this (ms). */
  joinMs?: number;
  /** Outbound calls: longest wait for the person's hello before greeting. */
  helloWaitMs?: number;
  /** Transcribe a voicemail with the line's own speech-to-text (Twilio's paid transcription stays off). */
  transcribeVoicemail?: (wav: Buffer) => Promise<string>;
  /** Quiet needed before replying (default 1200 ms). joinMs is the older name. */
  endSilenceMs?: number;
  /** Caller-audio energy that counts as speech (mean |linear| per 20 ms frame, default 400). */
  vadThreshold?: number;
  /** Quietest level that can still count as speech once the line's noise floor is known (default 150). */
  vadMinThreshold?: number;
  /** After a barge-in, say the stopped line again if nothing is heard within this long (default 2000 ms). */
  resayMs?: number;
  /** Mobile callers: frames of speech (20 ms each) before a barge-in (default 6). */
  mobileBargeFrames?: number;
  /** Join window once the caller has started reading out a phone number (default 2000 ms). */
  digitJoinMs?: number;
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
export const VOICEMAIL_PROMPT = `${OWNER_NAME} can't come to the phone. Please leave a message after the tone.`;

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

  const voicemail = (callSid: string, spoken = false) => {
    return (
      // With no owner phone, the line already said this in its own voice before the stream closed.
      (spoken ? "" : `<Say ${VOICE}>${xml(VOICEMAIL_PROMPT)}</Say>`) +
      `<Record maxLength="120" timeout="5" playBeep="true" action="${xml(`${base}/phone/recorded`)}" method="POST"` +
      ` recordingStatusCallback="${xml(`${base}/phone/recording`)}" recordingStatusCallbackMethod="POST"` +
      ` recordingStatusCallbackEvent="completed"` +
      `/>` +
      `<Hangup/>`
    );
  };

  app.post("/phone/voice", (req, res) => {
    if (!signed(req, res)) return;
    const callSid = String(req.body.CallSid ?? "");
    // On a call the line places (outbound), the customer is the one called.
    const outbound = String(req.body.Direction ?? "").startsWith("outbound");
    const from = String((outbound ? req.body.To : req.body.From) ?? "");
    const wsUrl = base.replace(/^http/, "ws") + "/phone/stream";
    twiml(
      res,
      `<Connect><Stream url="${xml(wsUrl)}">` +
        `<Parameter name="token" value="${streamToken(token, callSid)}"/>` +
        `<Parameter name="caller" value="${xml(from)}"/>` +
        `<Parameter name="direction" value="${outbound ? "outbound" : "inbound"}"/>` +
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
    twiml(res, voicemail(callSid, true));
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
      if (opts.transcribeVoicemail && opts.accountSid && url.startsWith("https://api.twilio.com/")) {
        void (async () => {
          try {
            const r = await fetchImpl(`${url}.wav`, {
              headers: { authorization: "Basic " + Buffer.from(`${opts.accountSid}:${token}`).toString("base64") },
            });
            if (!r.ok) return;
            const text = (await opts.transcribeVoicemail!(Buffer.from(await r.arrayBuffer()))).trim().slice(0, 500);
            if (text) noteVoicemailText(callSid, text);
          } catch (err) {
            console.error("phone line: voicemail transcription failed", (err as Error).message);
          }
        })();
      }
    } else {
      opts.callLog.update(callSid, { voicemail: "none" });
    }
    res.status(204).end();
  });

  // Voicemail text (Twilio transcription). An order request in it is logged as a request for Sam.
  app.post("/phone/transcribed", (req, res) => {
    if (!signed(req, res)) return;
    const callSid = String(req.body.CallSid ?? "");
    const text = String(req.body.TranscriptionText ?? "").trim().slice(0, 500);
    if (String(req.body.TranscriptionStatus ?? "completed") === "completed" && text) noteVoicemailText(callSid, text);
    res.status(204).end();
  });

  /** Voicemail text into the log; an order request in it is logged as a request for Sam. */
  function noteVoicemailText(callSid: string, text: string) {
    const entry = opts.callLog.list().find((e) => e.ref === callSid);
    const wantsOrder = ORDER_REQUEST.test(text);
    opts.callLog.update(callSid, {
      message: text,
      ...(wantsOrder && entry && !entry.asked.includes(ASKED.orderRequest) ? { asked: [...entry.asked, ASKED.orderRequest] } : {}),
    });
  }

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
/** G.711 μ-law byte -> 16-bit linear. */
const MULAW = Int16Array.from({ length: 256 }, (_, i) => {
  const u = ~i & 0xff;
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
  return u & 0x80 ? 0x84 - t : t - 0x84;
});

export function digitsStillComing(phase: string | undefined, joined: string): boolean {
  if (/@|\bat\b/i.test(joined)) return false;
  const n = spokenDigits(joined).length;
  if (n < 1 && !((phase === "ask_order" || phase === "confirm_order") && /\b(thousand|hundred)\b/i.test(joined))) return false;
  if ((phase === "ask_order" || phase === "confirm_order") && /\b(and|thousand|hundred)[\s,.]*$/i.test(joined)) return true;
  if (phase === "ask_order" || phase === "confirm_order") return !readOrderNumber(joined) && (n < 4 || /\b(thousand|hundred)\b/i.test(joined));
  if (phase === "ask_contact") return n < 10;
  if (phase === "ask_name") return n < 3;
  return false;
}

/** Call 7: a mobile line (background noise) needs louder, longer speech before the line stops. */
export function isMobileNumber(n: string): boolean {
  return /^(\+?61|0)4\d{8}$/.test(n.replace(/[\s()-]/g, ""));
}

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
  // Turn end is ours, not xAI's: reply only after real silence on the caller's own audio
  // (about 1.2 s, or 2 s while reading out a number), and never while they are talking.
  const endSilenceMs = opts.endSilenceMs ?? opts.joinMs ?? 1200;
  const digitJoinMs = opts.digitJoinMs ?? 2000;
  const maxHoldMs = 12_000;
  let pending: string[] = [];
  let lastPieceAt = 0;
  let firstPieceAt = 0;
  let heardAt = 0;
  let awaitingReply = false;
  const joinWaits: number[] = [];
  const replyGaps: number[] = [];
  const bargeIns: number[] = [];
  let speaking = false;
  let playId = 0;
  /** Caller voice activity from the Twilio audio (energy VAD). */
  let lastVoiceAt = 0;
  let voicedFrames = 0;
  let onsetAt = 0;
  const vadThreshold = opts.vadThreshold ?? 400;
  const vadMin = Math.min(opts.vadMinThreshold ?? 150, vadThreshold);
  /** Running noise floor of the caller's line; the speech threshold adapts to it (quiet talkers). */
  let noiseFloor = 50;
  let audioSeen = false;
  let currentLine = "";
  let resayTimer: NodeJS.Timeout | null = null;
  // Call 7: 2.6 s of dead air after a stop. Re-say (or answer) within 1 s.
  const resayMs = opts.resayMs ?? 700;
  let mobile = false;
  /** Frames of speech (20 ms each) before a barge-in stops the line: 2 on a landline, 6 (120 ms) on a mobile. */
  const bargeFrames = () => (mobile ? opts.mobileBargeFrames ?? 6 : 2);
  const threshold = () => {
    const t = Math.max(vadMin, Math.min(vadThreshold, noiseFloor * 10));
    // Mobile: at least 1.5x the bar and 4x the line's noise floor, so noise doesn't stop the line.
    return mobile ? Math.max(t * 1.5, noiseFloor * 4) : t;
  };
  /**
   * Digits expected and still coming (call 7: the 2 s window only then, 1.2 s otherwise):
   * order number under 4 digits, phone under 10, last-3 under 3.
   */
  const midNumber = () => digitsStillComing(session?.phase, pending.join(" "));
  let joinTimer: NodeJS.Timeout | null = null;
  let waitingForHello = false;
  let startFlow: (() => void) | null = null;
  let greetingAt = 0;
  let sayLine: (text: string) => Promise<void> = async () => {};
  /** Stop the line the instant the caller starts talking (barge-in, any line). */
  const stopPlayback = (why: string) => {
    if (!speaking || !opts.bargeIn) return;
    sendTwilio({ event: "clear", streamSid });
    voice?.stop?.();
    for (const done of marks.values()) done();
    marks.clear();
    playId += 1;
    speaking = false;
    const ms = onsetAt ? Date.now() - onsetAt : 0;
    bargeIns.push(ms);
    note("caller", `(talking: line stopped, ${why}, ${ms} ms after speech onset)`);
    if (why !== "turn taken") armResay(currentLine, joinWaits.length);
  };
  /** Stopped but then nothing came: say the stopped line again rather than leave dead air. */
  const armResay = (line: string, turns: number) => {
    if (resayTimer) clearTimeout(resayTimer);
    if (!line) return;
    const check = () => {
      resayTimer = null;
      if (ended || joinWaits.length !== turns || pending.length || speaking) return;
      if (Date.now() - lastVoiceAt < 250) {
        resayTimer = setTimeout(check, 100);
        return;
      }
      note("line", "(nothing heard after the stop: saying it again)");
      void run(async () => {
        if (joinWaits.length === turns && !pending.length) await sayLine(line);
      });
    };
    resayTimer = setTimeout(check, resayMs);
  };
  const callerSpeechStarted = (why: string) => {
    clearSilence();
    stopPlayback(why);
  };
  const flush = () => {
    if (joinTimer) clearTimeout(joinTimer);
    joinTimer = null;
    if (resayTimer) clearTimeout(resayTimer);
    resayTimer = null;
    if (!pending.length) return;
    const text = pending.join(" ");
    pending = [];
    firstPieceAt = 0;
    // A bare "hello" landing on the greeting (first turn): let the greeting finish; don't restart it.
    if (joinWaits.length === 0 && HELLO_ONLY.test(text) && (speaking || Date.now() - greetingAt < 6000)) {
      note("caller", `${text} (hello during the greeting: ignored)`);
      return;
    }
    const waited = Date.now() - speechEndRef();
    joinWaits.push(waited);
    heardAt = Date.now();
    awaitingReply = true;
    note("caller", `${text} [quiet ${waited} ms before reply]`);
    stopPlayback("turn taken");
    void run((s) => s.heard(text));
  };
  /** Reply only once the caller has been quiet long enough; re-check until then. */
  const checkTurn = () => {
    if (joinTimer) clearTimeout(joinTimer);
    joinTimer = null;
    if (!pending.length) return;
    const need = midNumber() ? Math.max(endSilenceMs, digitJoinMs) : endSilenceMs;
    // Quiet counts from the end of his real speech (our VAD), not from when the text arrived;
    // still give speech-to-text 100 ms for a follow-on piece.
    const quiet = Date.now() - speechEndRef();
    const pieceGap = audioSeen ? 100 : 0;
    const sincePiece = Date.now() - lastPieceAt;
    if ((quiet >= need && sincePiece >= pieceGap) || Date.now() - firstPieceAt >= maxHoldMs) return flush();
    joinTimer = setTimeout(checkTurn, Math.max(need - quiet, pieceGap - sincePiece, 1));
  };
  /** When he last spoke: our VAD when we have his audio, else when the text arrived. */
  function speechEndRef() {
    return audioSeen && lastVoiceAt ? lastVoiceAt : Math.max(lastPieceAt, lastVoiceAt);
  }
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const heardPiece = (text: string) => {
    if (waitingForHello) {
      note("caller", `${text} (hello, before the greeting)`);
      startFlow?.();
      return;
    }
    // Speech-to-text can resend a piece with more on the end ("It's 0 4 9 1" then "It's 0 4 9 1 5 7 ..."): keep the longer.
    const last = pending.at(-1);
    if (last !== undefined && norm(text).startsWith(norm(last))) pending[pending.length - 1] = text;
    else if (last !== undefined && norm(last).startsWith(norm(text))) {
      /* already have it */
    } else pending.push(text);
    if (pending.length === 1 && !firstPieceAt) firstPieceAt = Date.now();
    lastPieceAt = Date.now();
    checkTurn();
  };
  const voiceFrame = (b64: string) => {
    const bytes = Buffer.from(b64, "base64");
    if (!bytes.length) return;
    let sum = 0;
    for (const b of bytes) sum += Math.abs(MULAW[b]!);
    audioSeen = true;
    const level = sum / bytes.length;
    if (level > threshold()) {
      voicedFrames += 1;
      if (voicedFrames === 1) onsetAt = Date.now();
      if (voicedFrames >= 2) lastVoiceAt = Date.now();
      if (voicedFrames === bargeFrames()) callerSpeechStarted("caller audio");
    } else {
      voicedFrames = 0;
      // Falls quickly to a quiet line, rises slowly (so speech can't drag it up).
      noiseFloor = level < noiseFloor ? noiseFloor * 0.9 + level * 0.1 : noiseFloor * 0.98 + level * 0.02;
    }
  };
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
    silenceTimer = setTimeout(() => {
      // Still talking (or just stopped): not silence.
      if (Date.now() - Math.max(lastVoiceAt, lastPieceAt) < silenceMs || pending.length) return armSilence();
      void run((s) => s.silence());
    }, silenceMs);
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
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    if (callSid) {
      opts.callLog.update(callSid, {
        ...(secs ? { voiceSeconds: secs } : {}),
        timings: { joinWaitMsAvg: avg(joinWaits), replyMsAvg: avg(replyGaps), turns: joinWaits.length, bargeInMsAvg: avg(bargeIns), bargeIns: bargeIns.length },
      });
    }
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
        mobile = isMobileNumber(String(params.caller ?? ""));
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
              if (awaitingReply) {
                awaitingReply = false;
                replyGaps.push(Date.now() - heardAt);
                note("line", `(reply audio ${Date.now() - heardAt} ms after the caller's turn was taken)`);
              }
              sendTwilio({ event: "media", streamSid, media: { payload: b64 } });
            },
            onHeard(text) {
              heardPiece(text);
            },
            onInterrupted() {
              const ours = mobile ? voicedFrames >= bargeFrames() : Date.now() - lastVoiceAt < 600;
              if (!audioSeen || ours) stopPlayback("speech-to-text");
            },
            onSpeechStarted() {
              // xAI's speech-start can land ~0.5-1 s late: only stop the line for speech our VAD
              // heard just now (or when we have no audio of our own), not for a sound that ended before the line began.
              const ours = mobile ? voicedFrames >= bargeFrames() : Date.now() - lastVoiceAt < 600;
              if (!audioSeen || ours) callerSpeechStarted("speech-to-text");
              else clearSilence();
              // Outbound: greet once the person has said hello (speech start + a beat).
              if (waitingForHello && startFlow) setTimeout(() => startFlow?.(), 700);
              if (!audioSeen) lastVoiceAt = Date.now();
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
        sayLine = async (text: string) => {
          bytes = 0;
          note("line", text);
          // Barge-in (flag): every line can be talked over, and the caller's audio is never dropped.
          // Mobile: xAI's own speech-start would stop the line on background noise, so it is not told
          // the line is interruptible; our VAD (higher bar) does the stopping instead.
          const interruptible = !!opts.bargeIn && !mobile;
          speaking = true;
          currentLine = text;
          const id = ++playId;
          await voice!.say(text, { interruptible });
          // Stopped by a barge-in while it was being generated: nothing left to play out.
          if (id === playId) await playMark(bytes);
          if (id === playId) speaking = false;
        };
        session = new CallSession({
          ref: callSid,
          telephony: {
            say: (text) => sayLine(text),
            ringOwner: async () => {
              opts.onAfter(callSid, "handover");
              // No owner phone: straight to voicemail, so say the prompt in the line's own voice.
              if (!opts.ownerNumber) {
                bytes = 0;
                note("line", VOICEMAIL_PROMPT);
                await voice!.say(VOICEMAIL_PROMPT);
                await playMark(bytes);
              }
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
          lookupByName: opts.lookupByName,
          flags: { confirmReask: !!opts.confirmReask },
          log: opts.callLog,
        });
        const caller = String(params.caller ?? "");
        const begin = () => {
          if (startFlow === null) return;
          startFlow = null;
          waitingForHello = false;
          greetingAt = Date.now();
          void run((s) => s.start(normaliseAuPhone(caller) ?? caller));
        };
        startFlow = begin;
        note("line", `(voice ready ${Date.now() - t0} ms after stream start)`);
        // Call 7: waiting for the person's "hello" left 13 s of dead air on a mobile. Outbound now
        // greets as soon as the stream is up (helloWaitMs 0); a "hello" over the greeting is ignored.
        const helloWait = opts.helloWaitMs ?? 0;
        if (params.direction === "outbound" && helloWait > 0) {
          waitingForHello = true;
          setTimeout(begin, helloWait);
        } else begin();
        return;
      }
      case "media":
        if (msg.media?.track && msg.media.track !== "inbound") return;
        if (typeof msg.media?.payload === "string") {
          voiceFrame(msg.media.payload);
          voice?.sendAudio(msg.media.payload);
        }
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
