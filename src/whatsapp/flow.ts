import { normaliseAuPhone, normaliseEmail } from "../phone/normalise.ts";
import { STATUS_WORDS, type OrderSource } from "../phone/orders.ts";
import { OWNER_NAME, SHOP_NAME } from "../phone/flow.ts";
import { SHOP_INFO } from "../phone/shopinfo.ts";
import { emailMatchesLoosely } from "../phone/normalise.ts";

/**
 * WhatsApp chat flow for Sam's Café: "where's my order" replies plus enquiry
 * (lead) capture. Pure: text in, replies + effects out. Reads orders only.
 *
 * Privacy: a status is only sent when the chat comes from the phone on the
 * order, or the customer gives the order's email. Wrong number / wrong email
 * / unknown order all get the same answer and go to Sam.
 */
export type ChatPhase =
  | { kind: "idle" }
  | { kind: "ask_order" }
  | { kind: "ask_email"; order: string; tries: number }
  | { kind: "lead_name" }
  | { kind: "lead_need"; name: string };

export type Lead = { name: string; need: string; from: string };
export type Handoff = { reason: "no_match" | "person" | "change"; from: string; text: string };

export type ChatEffect = { type: "lead"; lead: Lead } | { type: "handoff"; handoff: Handoff };

export type ChatResult = { phase: ChatPhase; replies: string[]; effects: ChatEffect[] };

/** Shop settings for the chat. orderUrl unset = no "order online" line. */
export type ChatConfig = { orderUrl?: string; replyPromise?: string };
export const DEFAULT_REPLY_PROMISE = "as soon as they can";

export const TEXTS = {
  welcome: `Hi, thanks for messaging ${SHOP_NAME}. I can check where your order is, or take an enquiry (catering, bookings, bulk orders) for ${OWNER_NAME}. Just tell me which, or send your order number.`,
  askOrder: "Sure. What's your order number? It's the 4 digits on your confirmation.",
  askEmail:
    "Thanks. To keep orders private, please reply with the email address you used for that order.",
  emailRetry: "That doesn't look like an email address. Please send the email you used for the order.",
  noMatch: `Sorry, I couldn't match those details to an order. I've passed your message to ${OWNER_NAME}, who will reply here as soon as possible.`,
  leadName: `Happy to help. What's your name?`,
  leadNeed: (name: string) =>
    `Thanks ${name}. What do you need, and for when? (For example: "coffee and banana bread for 12 people, Friday 9am".)`,
  leadDone: (name: string, promise: string = DEFAULT_REPLY_PROMISE) =>
    `Got it, thanks ${name}. I've passed this to ${OWNER_NAME}, who will reply on this chat ${promise}.`,
  person: `No problem. I've let ${OWNER_NAME} know you'd like to chat, and they'll reply here as soon as possible.`,
  change: `I can't change orders here, but I've passed your message to ${OWNER_NAME}, who will reply as soon as possible.`,
  newOrder: (orderUrl?: string) =>
    `I can't take new orders on this chat${orderUrl ? `, but you can order at ${orderUrl}` : ""}. For a big or catering order, reply "enquiry" and I'll pass the details to ${OWNER_NAME}.`,
  hours: SHOP_INFO.hours,
  where: SHOP_INFO.where,
} as const;

const RX = {
  person: /\b(sam|owner|manager|human|real person|someone|staff|call me)\b/i,
  change: /\b(cancel|change|refund|wrong|missing|cold|complain|late)\b/i,
  lead: /\b(enquir|inquir|cater|catering|booking|book a|function|event|quote|bulk|wholesale|party|office order|meeting)\w*/i,
  newOrder: /\b(can i (order|get)|i'?d like to order|place an order|new order)\b/i,
  status: /\b(where|status|track|order|delivery|deliver|arriv|ready|eta)\w*/i,
  hours: /\b(open|close|hours|opening|trading)\w*/i,
  where: /\b(address|location|located|where are you|find you)\b/i,
};

function orderNumberIn(text: string): string | null {
  const m = text.match(/(?<!\d)#?(\d{4})(?!\d)/);
  return m ? m[1]! : null;
}

function cleanName(text: string): string {
  const t = text.replace(/^(hi|hey|hello)[,!. ]*/i, "").replace(/^(it'?s|i'?m|my name is|this is)\s+/i, "");
  const word = (t.match(/[A-Za-z][A-Za-z'-]{0,30}/) ?? [""])[0];
  return word ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : "there";
}

function statusReply(source: OrderSource, number: string): string {
  const order = source.find(number)!;
  return `Order ${number} (${order.item}): ${STATUS_WORDS[order.status].said}`;
}

function startOrder(source: OrderSource, number: string, from: string): ChatResult {
  const order = source.find(number);
  const fromPhone = normaliseAuPhone(from.replace(/^whatsapp:/, ""));
  if (order && fromPhone && normaliseAuPhone(order.phone) === fromPhone) {
    return { phase: { kind: "idle" }, replies: [statusReply(source, number)], effects: [] };
  }
  // Unknown order and someone else's order look the same from here.
  return { phase: { kind: "ask_email", order: number, tries: 0 }, replies: [TEXTS.askEmail], effects: [] };
}

export function chatStep(source: OrderSource, phase: ChatPhase, from: string, raw: string, config: ChatConfig = {}): ChatResult {
  const orderUrl = config.orderUrl && /^https:\/\/\S+$/.test(config.orderUrl) ? config.orderUrl : undefined;
  const promise = config.replyPromise?.trim().slice(0, 60) || DEFAULT_REPLY_PROMISE;
  const text = String(raw ?? "").slice(0, 600).trim();
  const handoff = (reason: Handoff["reason"], reply: string): ChatResult => ({
    phase: { kind: "idle" },
    replies: [reply],
    effects: [{ type: "handoff", handoff: { reason, from, text } }],
  });

  switch (phase.kind) {
    case "ask_order": {
      const n = orderNumberIn(text);
      if (n) return startOrder(source, n, from);
      if (RX.person.test(text)) return handoff("person", TEXTS.person);
      return handoff("no_match", TEXTS.noMatch);
    }
    case "ask_email": {
      const email = normaliseEmail((text.match(/[^\s<>]+@[^\s<>]+/) ?? [text])[0]!);
      if (!email) {
        if (phase.tries < 1) return { phase: { ...phase, tries: phase.tries + 1 }, replies: [TEXTS.emailRetry], effects: [] };
        return handoff("no_match", TEXTS.noMatch);
      }
      const order = source.find(phase.order);
      if (order && emailMatchesLoosely(order.email, email)) {
        return { phase: { kind: "idle" }, replies: [statusReply(source, phase.order)], effects: [] };
      }
      return handoff("no_match", TEXTS.noMatch);
    }
    case "lead_name": {
      const name = cleanName(text);
      return { phase: { kind: "lead_need", name }, replies: [TEXTS.leadNeed(name)], effects: [] };
    }
    case "lead_need": {
      const lead: Lead = { name: phase.name, need: text, from };
      return { phase: { kind: "idle" }, replies: [TEXTS.leadDone(phase.name, promise)], effects: [{ type: "lead", lead }] };
    }
    case "idle": {
      const n = orderNumberIn(text);
      if (RX.change.test(text)) return handoff("change", TEXTS.change);
      if (RX.person.test(text)) return handoff("person", TEXTS.person);
      if (RX.lead.test(text)) return { phase: { kind: "lead_name" }, replies: [TEXTS.leadName], effects: [] };
      if (n) return startOrder(source, n, from);
      if (RX.newOrder.test(text)) return { phase, replies: [TEXTS.newOrder(orderUrl)], effects: [] };
      if (RX.where.test(text)) return { phase, replies: [TEXTS.where], effects: [] };
      if (RX.hours.test(text)) return { phase, replies: [TEXTS.hours], effects: [] };
      if (RX.status.test(text)) return { phase: { kind: "ask_order" }, replies: [TEXTS.askOrder], effects: [] };
      return { phase, replies: [TEXTS.welcome], effects: [] };
    }
  }
}
