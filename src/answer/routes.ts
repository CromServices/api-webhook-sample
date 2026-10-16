import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { normaliseContact, sayDigits } from "../phone/normalise.ts";
import { twilioSignature } from "../phone/twilio.ts";
import { timingSafeEqual } from "node:crypto";
import { summaryEmail, type MailSender, type SupportMessage } from "./mail.ts";
import { readReference, sayReference } from "./reference.ts";
import { AI_QUESTION, ASKED_ABOUT_AI, W } from "./words.ts";

/**
 * Crom Services answering line (Twilio, TwiML + Gather, no live handover).
 *   POST /answer/voice        greeting + menu (1 support message, 2 Sam's Café sample -> /phone/voice)
 *   POST /answer/menu|name|contact|ref|confirm   one step each (Gather action)
 *   POST /answer/recorded     <Record> done -> closing line
 *   POST /answer/recording    recording ready -> transcript + summary email
 *   POST /answer/status       call ended -> email whatever was captured if the caller hung up early
 * Every POST needs a valid X-Twilio-Signature; 403 otherwise, or when the line has no token.
 */
export type AnswerOptions = {
  authToken: string;
  accountSid: string;
  publicBaseUrl: string;
  mail?: MailSender;
  timeZone?: string;
  statePath?: string;
  transcribe?: (wav: Buffer) => Promise<string>;
  fetchImpl?: typeof fetch;
  /** Wait for the recording callback before a hang-up email goes out (ms). */
  partialDelayMs?: number;
  now?: () => number;
};

type Call = SupportMessage & { step: string; tries: Record<string, number>; pendingRef?: string; emailed?: "sent" | "failed"; emailId?: string; emailError?: string; supportStarted: boolean };

const VOICE = 'voice="Polly.Olivia-Neural" language="en-AU"';
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const YES = /\b(yes|yeah|yep|yup|correct|right|that's it|that is|sure|affirmative|spot on)\b/i;
const NO = /\b(no|nope|nah|wrong|incorrect|not right|isn't)\b/i;

export function mountAnswerLine(app: Express, opts: AnswerOptions) {
  const base = opts.publicBaseUrl.replace(/\/$/, "");
  const token = opts.authToken;
  const tz = opts.timeZone ?? "Australia/Perth";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const calls = new Map<string, Call>();
  if (opts.statePath && existsSync(opts.statePath)) {
    try {
      for (const c of JSON.parse(readFileSync(opts.statePath, "utf8")) as Call[]) calls.set(c.ref, c);
    } catch {
      /* start empty */
    }
  }
  const persist = () => {
    if (!opts.statePath) return;
    mkdirSync(path.dirname(opts.statePath), { recursive: true });
    const rows = [...calls.values()].slice(-300);
    writeFileSync(`${opts.statePath}.tmp`, JSON.stringify(rows, null, 2));
    renameSync(`${opts.statePath}.tmp`, opts.statePath);
  };

  const signed = (req: Request, res: Response) => {
    const sig = req.header("x-twilio-signature") ?? "";
    const want = token && base ? twilioSignature(token, base + req.originalUrl, (req.body ?? {}) as Record<string, unknown>) : "";
    const a = Buffer.from(sig);
    const b = Buffer.from(want);
    if (!want || a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(403).type("text").send("Forbidden");
      return false;
    }
    return true;
  };
  const twiml = (res: Response, body: string) =>
    res.status(200).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
  const say = (t: string) => `<Say ${VOICE}>${xml(t)}</Say>`;
  const gather = (step: string, prompt: string, o: { digits?: "one" | "many"; hints?: string; timeout?: number } = {}) =>
    `<Gather input="speech dtmf" action="${xml(`${base}/answer/${step}`)}" method="POST" language="en-AU" speechTimeout="auto"` +
    ` speechModel="phone_call" enhanced="true" actionOnEmptyResult="true" timeout="${o.timeout ?? 6}"` +
    (o.digits === "one" ? ` numDigits="1"` : o.digits === "many" ? ` finishOnKey="#"` : "") +
    (o.hints ? ` hints="${xml(o.hints)}"` : "") +
    `>${say(prompt)}</Gather>` +
    // No input at all: come back to the same step with nothing heard.
    `<Redirect method="POST">${xml(`${base}/answer/${step}`)}</Redirect>`;

  const call = (req: Request): Call => {
    const ref = String(req.body.CallSid ?? "");
    let c = calls.get(ref);
    if (!c) {
      c = {
        ref,
        startedAt: new Date(now()).toISOString(),
        callerId: String(req.body.From ?? ""),
        name: "",
        contactHeard: "",
        contact: null,
        reference: "",
        referenceConfirmed: false,
        referenceHeard: [],
        issueText: "",
        recordingSeconds: null,
        partial: false,
        step: "menu",
        tries: {},
        supportStarted: false,
      };
      calls.set(ref, c);
    }
    return c;
  };
  const heard = (req: Request) => String(req.body.SpeechResult ?? "").trim();
  const keyed = (req: Request) => String(req.body.Digits ?? "").trim();
  const tried = (c: Call, step: string) => (c.tries[step] = (c.tries[step] ?? 0) + 1);
  /** The caller asked if this is a bot or a real person: L-064 answer, then the same question again. */
  const askedAboutAi = (text: string) => !!text && AI_QUESTION.test(text);

  const askName = (c: Call) => ((c.step = "name"), gather("name", W.name));
  const askContact = (c: Call) => ((c.step = "contact"), gather("contact", W.contact, { digits: "many" }));
  const askRef = (c: Call, again = false) => ((c.step = "ref"), gather("ref", again ? W.refAgain : W.ref, { digits: "many", hints: "no reference" }));
  const askIssue = (c: Call) => {
    c.step = "issue";
    return (
      say(W.issue) +
      `<Record maxLength="180" timeout="6" finishOnKey="#" playBeep="true" action="${xml(`${base}/answer/recorded`)}" method="POST"` +
      ` recordingStatusCallback="${xml(`${base}/answer/recording`)}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>` +
      `<Redirect method="POST">${xml(`${base}/answer/recorded`)}</Redirect>`
    );
  };

  app.post("/answer/voice", (req, res) => {
    if (!signed(req, res)) return;
    const c = call(req);
    persist();
    twiml(res, say(W.greeting) + gather("menu", W.menu, { digits: "one", hints: "support, one, two, Sam's Cafe" }));
  });

  app.post("/answer/menu", (req, res) => {
    if (!signed(req, res)) return;
    const c = call(req);
    const d = keyed(req);
    const s = heard(req);
    if (askedAboutAi(s)) return twiml(res, say(ASKED_ABOUT_AI) + gather("menu", W.menu, { digits: "one" }));
    if (d === "2" || /\b(two|2|sam|cafe|café)\b/i.test(s)) {
      c.step = "cafe";
      persist();
      return twiml(res, `<Redirect method="POST">${xml(`${base}/phone/voice`)}</Redirect>`);
    }
    if (d === "1" || /\b(one|1|support|message|help|order|job|problem|issue)\b/i.test(s) || tried(c, "menu") > 2) {
      c.supportStarted = true;
      persist();
      return twiml(res, askName(c));
    }
    persist();
    twiml(res, say(W.menuAgain) + gather("menu", W.menu, { digits: "one" }));
  });

  app.post("/answer/name", (req, res) => {
    if (!signed(req, res)) return;
    const c = call(req);
    const s = heard(req);
    if (askedAboutAi(s)) return twiml(res, say(ASKED_ABOUT_AI) + askName(c));
    if (!s && tried(c, "name") < 2) return twiml(res, say(W.menuAgain) + askName(c));
    c.name = s.replace(/^(my name is|my name's|it's|this is|i'm|i am)\s+/i, "").replace(/[.!?]+$/, "").slice(0, 80);
    persist();
    twiml(res, askContact(c));
  });

  app.post("/answer/contact", (req, res) => {
    if (!signed(req, res)) return;
    const c = call(req);
    const s = heard(req);
    const d = keyed(req);
    if (askedAboutAi(s)) return twiml(res, say(ASKED_ABOUT_AI) + askContact(c));
    if (!s && !d && tried(c, "contact") < 2) return twiml(res, say(W.menuAgain) + askContact(c));
    c.contactHeard = (s || d).slice(0, 160);
    const parsed = c.contactHeard ? normaliseContact(c.contactHeard) : null;
    c.contact = parsed ? { kind: parsed.kind, value: parsed.value } : null;
    persist();
    const back = c.contact
      ? W.heardAs(c.contact.kind === "phone" ? sayDigits(c.contact.value.replace(/^\+61/, "0")).replace(/-/g, " ") : c.contact.value.replace("@", " at ").replace(/\./g, " dot "))
      : "";
    twiml(res, (back ? say(back) : "") + askRef(c));
  });

  app.post("/answer/ref", (req, res) => {
    if (!signed(req, res)) return;
    const c = call(req);
    const s = heard(req);
    const d = keyed(req);
    if (askedAboutAi(s)) return twiml(res, say(ASKED_ABOUT_AI) + askRef(c));
    const n = tried(c, "ref");
    if (s || d) c.referenceHeard.push(d ? `keyed ${d}` : s);
    const r = readReference(s, d);
    if (r?.value === "none") {
      c.reference = "none";
      c.referenceConfirmed = true;
      persist();
      return twiml(res, askIssue(c));
    }
    if (!r) {
      if (n < 3) return (persist(), twiml(res, askRef(c, true)));
      c.reference = (s || d).slice(0, 60);
      c.referenceConfirmed = false;
      persist();
      return twiml(res, say(W.refKept) + askIssue(c));
    }
    c.pendingRef = r.value;
    c.step = "confirm";
    persist();
    twiml(res, gather("confirm", W.refConfirm(sayReference(r.value)), { digits: "one", hints: "yes, no" }));
  });

  app.post("/answer/confirm", (req, res) => {
    if (!signed(req, res)) return;
    const c = call(req);
    const s = heard(req);
    const d = keyed(req);
    const yes = d === "1" || (YES.test(s) && !NO.test(s.replace(/\bno (worries|problem)\b/i, "")));
    const no = d === "2" || (!yes && NO.test(s));
    if (yes) {
      c.reference = c.pendingRef ?? "";
      c.referenceConfirmed = true;
      persist();
      return twiml(res, askIssue(c));
    }
    if (no && (c.tries.ref ?? 0) < 3) {
      persist();
      return twiml(res, askRef(c, true));
    }
    if (!no && !s && !d && tried(c, "confirm") < 2) {
      return twiml(res, gather("confirm", W.refConfirm(sayReference(c.pendingRef ?? "")), { digits: "one" }));
    }
    // Still not confirmed after the tries: keep what we heard, flagged for checking.
    c.reference = c.pendingRef ?? "";
    c.referenceConfirmed = false;
    persist();
    twiml(res, say(W.refKept) + askIssue(c));
  });

  app.post("/answer/recorded", (req, res) => {
    if (!signed(req, res)) return;
    const c = call(req);
    const secs = Number(req.body.RecordingDuration ?? 0);
    c.step = "closing";
    persist();
    // No recording (silence or hash straight away): nothing will call /answer/recording, so send now.
    if (!req.body.RecordingUrl || secs < 1) void sendSummary(c);
    twiml(res, say(req.body.RecordingUrl && secs >= 1 ? W.done : W.noIssue) + "<Hangup/>");
  });

  app.post("/answer/recording", (req, res) => {
    if (!signed(req, res)) return;
    const c = call(req);
    const url = String(req.body.RecordingUrl ?? "");
    const secs = Number(req.body.RecordingDuration ?? 0);
    res.status(204).end();
    if (!url.startsWith("https://api.twilio.com/") || secs < 1) return void sendSummary(c);
    c.recordingSeconds = secs;
    persist();
    void (async () => {
      const auth = { authorization: "Basic " + Buffer.from(`${opts.accountSid}:${token}`).toString("base64") };
      let mp3: Buffer | null = null;
      try {
        if (opts.transcribe) {
          const wav = await fetchImpl(`${url}.wav`, { headers: auth });
          if (wav.ok) c.issueText = (await opts.transcribe(Buffer.from(await wav.arrayBuffer()))).trim().slice(0, 2000);
        }
      } catch (err) {
        console.error("answer line: transcript failed", (err as Error).message);
      }
      try {
        const r = await fetchImpl(`${url}.mp3`, { headers: auth });
        if (r.ok) mp3 = Buffer.from(await r.arrayBuffer());
      } catch (err) {
        console.error("answer line: recording fetch failed", (err as Error).message);
      }
      await sendSummary(c, mp3);
    })();
  });

  app.post("/answer/status", (req, res) => {
    if (!signed(req, res)) return;
    res.status(204).end();
    const c = calls.get(String(req.body.CallSid ?? ""));
    if (!c || !c.supportStarted || c.emailed) return;
    if (String(req.body.CallStatus ?? "") !== "completed") return;
    // Give the recording callback time to land first; if it never does, send what we have.
    setTimeout(() => {
      if (c.emailed) return;
      if (c.step !== "closing") c.partial = true;
      void sendSummary(c);
    }, opts.partialDelayMs ?? 60_000).unref?.();
  });

  async function sendSummary(c: Call, mp3?: Buffer | null) {
    if (c.emailed === "sent") return;
    if (!opts.mail) {
      c.emailed = "failed";
      c.emailError = "mail not set up";
      persist();
      return;
    }
    c.emailed = "sent"; // claim first so a parallel callback can't double-send
    const m = summaryEmail(c, tz);
    try {
      const r = await opts.mail({ ...m, attachments: mp3 ? [{ filename: "support-message.mp3", content: mp3.toString("base64") }] : undefined });
      if (r.ok) c.emailId = r.id;
      else ((c.emailed = "failed"), (c.emailError = r.error));
    } catch (err) {
      c.emailed = "failed";
      c.emailError = (err as Error).message;
    }
    if (c.emailed === "failed") console.error("answer line: summary email failed", c.emailError);
    persist();
  }

  return { calls, sendSummary };
}
