import type { Express, Request, Response } from "express";
import { twilioSignature } from "../phone/twilio.ts";
import { sampleOrderSource, type OrderSource } from "../phone/orders.ts";
import { createRateLimiter } from "../phone/lookup.ts";
import { timingSafeEqual } from "node:crypto";
import { chatStep, type ChatConfig, type ChatPhase, type Handoff, type Lead } from "./flow.ts";
import { inboxPage } from "./page.ts";

/**
 * WhatsApp side (Twilio Messaging webhook; works the same on the Twilio
 * WhatsApp Sandbox and a live WhatsApp sender):
 *   POST /whatsapp/inbound   message in -> TwiML <Message> reply(ies)
 *   GET  /whatsapp/inbox     owner view of enquiries and hand-offs (basic auth)
 * The inbound route needs a valid X-Twilio-Signature; with no auth token it answers 403.
 * Reads orders only. Never sends a message the customer didn't start.
 * Swap point: a Meta Cloud API adapter only needs to call handle(from, text) and send the replies.
 */
export type WhatsAppOptions = {
  authToken?: string;
  /** e.g. https://example.fly.dev (no trailing slash): the URL Twilio signs. */
  publicBaseUrl?: string;
  viewUser?: string;
  viewPassword?: string;
  orders?: OrderSource;
  now?: () => number;
  /** Messages per sender per minute. */
  perSenderPerMinute?: number;
  /** Chat goes back to the start after this much quiet. */
  idleMs?: number;
  /** Shop settings: order link (https only) and reply-time promise. */
  chat?: ChatConfig;
};

export type InboxRow =
  | { at: number; kind: "lead"; lead: Lead }
  | { at: number; kind: "handoff"; handoff: Handoff };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

export function twiml(replies: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${replies.map((r) => `<Message>${esc(r)}</Message>`).join("")}</Response>`;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function mountWhatsApp(app: Express, opts: WhatsAppOptions = {}) {
  const orders = opts.orders ?? sampleOrderSource();
  const now = opts.now ?? Date.now;
  const idleMs = opts.idleMs ?? 30 * 60_000;
  const chats = new Map<string, { phase: ChatPhase; at: number }>();
  const inbox: InboxRow[] = [];
  const limiter = createRateLimiter({ limit: opts.perSenderPerMinute ?? 10, windowMs: 60_000, now });

  function handle(from: string, text: string): string[] {
    const prev = chats.get(from);
    const phase: ChatPhase = prev && now() - prev.at < idleMs ? prev.phase : { kind: "idle" };
    const out = chatStep(orders, phase, from, text, opts.chat);
    chats.set(from, { phase: out.phase, at: now() });
    for (const e of out.effects) {
      inbox.push(e.type === "lead" ? { at: now(), kind: "lead", lead: e.lead } : { at: now(), kind: "handoff", handoff: e.handoff });
    }
    if (inbox.length > 200) inbox.splice(0, inbox.length - 200);
    return out.replies;
  }

  app.post("/whatsapp/inbound", (req: Request, res: Response) => {
    const token = opts.authToken, base = opts.publicBaseUrl;
    const sig = req.get("x-twilio-signature") ?? "";
    const params = (req.body ?? {}) as Record<string, string>;
    if (!token || !base || !sig || !same(twilioSignature(token, base + req.originalUrl, params), sig)) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }
    const from = String(params.From ?? "");
    if (!/^whatsapp:\+\d{6,15}$/.test(from)) {
      res.status(200).type("text/xml").send(twiml([]));
      return;
    }
    if (!limiter.take(from)) {
      res.status(200).type("text/xml").send(twiml([]));
      return;
    }
    res.status(200).type("text/xml").send(twiml(handle(from, String(params.Body ?? ""))));
  });

  app.get("/whatsapp/inbox", (req: Request, res: Response) => {
    const u = opts.viewUser, p = opts.viewPassword;
    if (!u || !p) { res.status(404).send("Not found"); return; }
    const h = req.get("authorization") ?? "";
    const want = "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
    if (!same(h, want)) {
      res.status(401).set("www-authenticate", 'Basic realm="Inbox"').send("Login needed");
      return;
    }
    res.set("cache-control", "no-store").type("html").send(inboxPage(inbox));
  });

  return { handle, inbox };
}
