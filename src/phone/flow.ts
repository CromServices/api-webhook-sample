import { normaliseContact, normaliseOrderNumber, readOrderNumber, sayDigits, spokenDigits } from "./normalise.ts";
import { SHOP_INFO } from "./shopinfo.ts";
import type { LookupResult } from "./lookup.ts";
import { NO_MATCH_SAY } from "./lookup.ts";
import { STATUS_WORDS } from "./orders.ts";

/**
 * The call, as a pure state machine: step(state, event) -> { state, actions }.
 * No I/O, no clock, no order writes. The runner (session.ts) carries out the
 * actions with real or mock phone, text and lookup adapters.
 *
 * There is deliberately no action that changes an order. Change requests are
 * handed to the owner.
 */

export const OWNER_NAME = "Sam";
export const SHOP_NAME = "Sam's Café";

/** Tries per question before offering Sam's voicemail. */
export const MAX_RETRIES = 2;

/** Second-try wording, so the line never says the same sentence twice in a row. */
export const SECOND_TRY: Record<string, string> = {
  ask_order: "Could you say the order number one digit at a time? Like one, oh, four, two.",
  ask_contact: "Try the mobile number one digit at a time, or spell out the email.",
  ask_name: "Just your first name, then the last three digits of your phone, please.",
  confirm_order: "Was that the right order number? Yes or no is fine.",
  told: "Anything else? You can check another order or ask for Sam.",
};

export const LINES = {
  // Under 4 seconds spoken. Detours (Sam, hours, no number) work without being listed.
  greet: `Hi, it's ${SHOP_NAME}. What's your order number?`,
  askOrderAgain: "Sorry, I missed that. What's the order number?",
  askContact: "Thanks. And what's the mobile number or email on the order?",
  askContactAgain: "Sorry, I missed that. What's the mobile or email on the order?",
  tryAgain: `${NO_MATCH_SAY} Let's try once more. What's the order number?`,
  anythingElse: "Is there anything else I can help with?",
  offer: `I can check another order, or put you through to ${OWNER_NAME}. Which would you like?`,
  handoffChange: `I can't change orders myself, but ${OWNER_NAME} can. I'll put you through now.`,
  handoffPerson: `No problem, I'll put you through to ${OWNER_NAME} now.`,
  handoffNoMatch: `I still couldn't match those details, so I'll put you through to ${OWNER_NAME}.`,
  handoffNotHeard: `I'm having trouble hearing you, so I'll put you through to ${OWNER_NAME}.`,
  connecting: `${OWNER_NAME}'s picking up now. Putting you through.`,
  noAnswer: `${OWNER_NAME} can't get to the phone right now. Please leave a short message after this, with your name, and ${OWNER_NAME} will call you back.`,
  messageTaken: `Thanks, I've passed that on to ${OWNER_NAME}, who'll call you back. Bye for now.`,
  bye: `Thanks for calling ${SHOP_NAME}. Bye for now.`,
  stillThere: "Are you still there?",
  noMessage: `I didn't hear a message, but I've let ${OWNER_NAME} know you called. Bye for now.`,
  confirmOrder: (n: string) => `Is that order ${sayDigits(n)}?`,
  confirmAgain: "Okay. What's the order number? One digit at a time is easiest.",
  noNumber: `No problem. Tell me the name on the order and the last three digits of your phone number. Or say "message" to leave ${OWNER_NAME} a message.`,
  askNameAgain: "Sorry, I didn't get that. What's the first name on the order, and the last three digits of your phone?",
  offTopic: `Sorry, I can only help with orders on this line, but I can take a message for ${OWNER_NAME}.`,
  handoffMessage: `No worries, I'll pass you to ${OWNER_NAME}'s voicemail so you can get a call back.`,
} as const;

/** Plain words for the call log. */
export const ASKED = {
  status: "Where's my order",
  change: "To change an order",
  person: `To talk to ${OWNER_NAME}`,
} as const;

export const TOLD = {
  noMatch: "Couldn't match the details",
  putThrough: `Put through to ${OWNER_NAME}`,
  callBack: `${OWNER_NAME} will call back`,
} as const;

export type HandoffReason = "change" | "person" | "message" | "no_match" | "not_heard";

export type Phase =
  | "idle"
  | "ask_order"
  | "confirm_order"
  | "ask_name"
  | "ask_contact"
  | "looking_up"
  | "told"
  | "ringing_owner"
  | "take_message"
  | "done";

export type FlowState = {
  phase: Phase;
  caller: string;
  orderNumber: string | null;
  failedLookups: number;
  misses: number;
  silences: number;
  asked: string[];
  told: string[];
  handedOver: boolean;
  handoffReason: HandoffReason | null;
  ownerAnswered: boolean | null;
  message: string | null;
  textedOwner: boolean;
  /** Last sentence spoken, so it is never said twice in a row. */
  lastSaid?: string;
};

export type FlowEvent =
  | { type: "call_started"; caller: string }
  | { type: "heard"; text: string }
  | { type: "silence" }
  | { type: "lookup_done"; result: LookupResult }
  | { type: "owner_answered" }
  | { type: "owner_no_answer" }
  /** The phone side (Twilio) takes over ringing Sam / voicemail. Its callbacks finish the log entry. */
  | { type: "handed_to_phone" }
  | { type: "hung_up" };

export type CallSummary = {
  caller: string;
  asked: string[];
  told: string[];
  handedOver: boolean;
  ownerAnswered: boolean | null;
  message: string | null;
  textedOwner: boolean;
};

export type FlowAction =
  | { type: "say"; text: string }
  | { type: "lookup"; orderNumber: string; contact: string }
  /** Caller has no order number: find one order by first name + last 3 phone digits (read-only). */
  | { type: "lookup_by_name"; text: string }
  | { type: "ring_owner" }
  | { type: "connect_owner" }
  | { type: "text_owner"; body: string }
  | { type: "hang_up" }
  | { type: "log"; summary: CallSummary };

/** Every action type the flow can produce. None of them writes to an order. */
export const ACTION_TYPES: readonly FlowAction["type"][] = [
  "say",
  "lookup",
  "lookup_by_name",
  "ring_owner",
  "connect_owner",
  "text_owner",
  "hang_up",
  "log",
];

export type Intent = "change" | "person" | "message" | "hours" | "location" | "no_number" | "no" | "yes" | "none";

const CHANGE =
  /\b(change|changing|cancel|cancelling|canceling|refund|swap|switch|modify|amend|edit|update|wrong (item|order|thing)|instead|different address|add (a|an|another|one|some)|remove|take off)\b/i;
const PERSON =
  /\b(talk|speak|chat)\b[^.?!]*\b(someone|somebody|person|human|sam|owner|staff|manager|real|anyone)\b|\b(real person|a human|operator|representative|put me through|call me back|talk to sam|speak to sam)\b/i;
const MESSAGE = /\b(leave (a |him |her |them )?(message|voicemail)|voicemail|take a message|message)\b/i;
const HOURS = /\b(open|opening|close|closing|hours|what time|when do you)\b/i;
const LOCATION = /\b(where are you|where is the (shop|cafe|café)|address|location|located|directions|find you)\b/i;
const NO_NUMBER =
  /\b(don'?t|do not|can'?t|cannot|didn'?t|never) (have|know|remember|find|get|got|see)\b[^.?!]*\b(number|order|receipt|it)\b|\b(lost|forgot|no idea)\b[^.?!]*\b(number|receipt)\b|\bno (order )?number\b/i;
const NO = /^\s*(no|nope|nah|no thanks|no thank you)\b|\b(that's all|that is all|that's it|nothing else|all good|bye|goodbye)\b/i;
const YES = /^\s*(yes|yeah|yep|yup|sure|please)\b|\b(another order|check another|one more)\b/i;

export function detectIntent(text: string): Intent {
  if (CHANGE.test(text)) return "change";
  if (PERSON.test(text)) return "person";
  if (NO_NUMBER.test(text)) return "no_number";
  if (MESSAGE.test(text)) return "message";
  if (LOCATION.test(text)) return "location";
  if (HOURS.test(text)) return "hours";
  if (NO.test(text)) return "no";
  if (YES.test(text)) return "yes";
  return "none";
}

export function initialState(): FlowState {
  return {
    phase: "idle",
    caller: "",
    orderNumber: null,
    failedLookups: 0,
    misses: 0,
    silences: 0,
    asked: [],
    told: [],
    handedOver: false,
    handoffReason: null,
    ownerAnswered: null,
    message: null,
    textedOwner: false,
  };
}

function addOnce(list: string[], value: string): string[] {
  return list.includes(value) ? list : [...list, value];
}

function summary(state: FlowState): CallSummary {
  return {
    caller: state.caller,
    asked: state.asked.length ? state.asked : [ASKED.status],
    told: state.told,
    handedOver: state.handedOver,
    ownerAnswered: state.ownerAnswered,
    message: state.message,
    textedOwner: state.textedOwner,
  };
}

function finish(state: FlowState, said: string | null): { state: FlowState; actions: FlowAction[] } {
  const done = { ...state, phase: "done" as const };
  const actions: FlowAction[] = [];
  if (said) actions.push({ type: "say", text: said });
  actions.push({ type: "hang_up" }, { type: "log", summary: summary(done) });
  return { state: done, actions };
}

function handoff(state: FlowState, reason: HandoffReason): { state: FlowState; actions: FlowAction[] } {
  const line =
    reason === "change"
      ? LINES.handoffChange
      : reason === "person"
        ? LINES.handoffPerson
        : reason === "message"
          ? LINES.handoffMessage
          : reason === "no_match"
          ? LINES.handoffNoMatch
          : LINES.handoffNotHeard;
  let asked = state.asked;
  if (reason === "change") asked = addOnce(asked, ASKED.change);
  if (reason === "person" || reason === "message") asked = addOnce(asked, ASKED.person);
  if (asked.length === 0) asked = [ASKED.status];
  const told = addOnce(state.told, TOLD.putThrough);
  return {
    state: { ...state, phase: "ringing_owner", handedOver: true, handoffReason: reason, asked, told, silences: 0 },
    actions: [{ type: "say", text: line }, { type: "ring_owner" }],
  };
}

/** 0491570006 -> "0491 570 006", (08) numbers -> "08 5550 1234", for the owner's text. */
function spaced(phone: string): string {
  if (/^04\d{8}$/.test(phone)) return `${phone.slice(0, 4)} ${phone.slice(4, 7)} ${phone.slice(7)}`;
  if (/^0\d{9}$/.test(phone)) return `${phone.slice(0, 2)} ${phone.slice(2, 6)} ${phone.slice(6)}`;
  return phone;
}

/** Plain GSM characters only, so a text is 2 segments at most for a normal message. */
function ownerText(state: FlowState): string {
  const wanted =
    state.handoffReason === "change"
      ? "want to change an order"
      : state.handoffReason === "person"
        ? "asked to talk to you"
        : state.handoffReason === "message"
          ? "wanted to leave a message"
          : state.handoffReason === "no_match"
          ? "asked about an order, but the details didn't match"
          : "called, but the line was hard to hear";
  const who = state.caller ? `Missed call from ${spaced(state.caller)}` : "Missed call (no caller number)";
  const order = state.orderNumber ? ` about order ${state.orderNumber}` : "";
  const message = state.message ? ` Message: "${state.message}"` : " No message left.";
  return `${SHOP_NAME} line. ${who}${order}. They ${wanted}.${message} Please call them back.`;
}

const REPROMPT: Partial<Record<Phase, string>> = {
  ask_order: LINES.askOrderAgain,
  confirm_order: LINES.confirmAgain,
  ask_name: LINES.askNameAgain,
  ask_contact: LINES.askContactAgain,
  told: LINES.anythingElse,
};

/** A number heard: read it back first if it could have been misheard, else go on. */
function gotNumber(state: FlowState, reading: { number: string; sure: boolean }) {
  const next = { ...state, orderNumber: reading.number, misses: 0, asked: addOnce(state.asked, ASKED.status) };
  if (!reading.sure) {
    return { state: { ...next, phase: "confirm_order" as const }, actions: [{ type: "say" as const, text: LINES.confirmOrder(reading.number) }] };
  }
  return { state: { ...next, phase: "ask_contact" as const }, actions: [{ type: "say" as const, text: LINES.askContact }] };
}

/** Backstop: if a line would repeat the one just said, say it differently. */
export function step(state: FlowState, event: FlowEvent): { state: FlowState; actions: FlowAction[] } {
  const out = stepInner(state, event);
  let last = state.lastSaid ?? "";
  const actions = out.actions.map((a) => {
    if (a.type !== "say") return a;
    let text = a.text;
    if (text === last) {
      const alt = SECOND_TRY[out.state.phase];
      text = alt && alt !== last ? alt : `Sorry, one more time. ${text}`;
    }
    last = text;
    return { ...a, text };
  });
  return { state: { ...out.state, lastSaid: last }, actions };
}

function stepInner(state: FlowState, event: FlowEvent): { state: FlowState; actions: FlowAction[] } {
  if (state.phase === "done") return { state, actions: [] };

  if (event.type === "hung_up") {
    const done = { ...state, phase: "done" as const };
    const actions: FlowAction[] = [];
    // Hung up while waiting to leave a message: still let the owner know.
    if (state.phase === "take_message" || state.phase === "ringing_owner") {
      const texted = { ...done, textedOwner: true, told: addOnce(done.told, TOLD.callBack) };
      actions.push({ type: "text_owner", body: ownerText(texted) }, { type: "log", summary: summary(texted) });
      return { state: texted, actions };
    }
    actions.push({ type: "log", summary: summary(done) });
    return { state: done, actions };
  }

  switch (state.phase) {
    case "idle": {
      if (event.type !== "call_started") return { state, actions: [] };
      return {
        state: { ...state, phase: "ask_order", caller: event.caller },
        actions: [{ type: "say", text: LINES.greet }],
      };
    }

    case "ask_order":
    case "confirm_order":
    case "ask_name":
    case "ask_contact":
    case "told": {
      if (event.type === "silence") {
        // Reprompt once, then offer Sam's voicemail rather than stall or hang up.
        if (state.silences >= 1) return handoff({ ...state, silences: 0 }, "not_heard");
        return {
          state: { ...state, silences: state.silences + 1 },
          actions: [{ type: "say", text: `${LINES.stillThere} ${REPROMPT[state.phase] ?? ""}`.trim() }],
        };
      }
      if (event.type !== "heard") return { state, actions: [] };
      const heard = { ...state, silences: 0 };
      const text = event.text;
      const reprompt = (st: FlowState, first: string) => ({
        state: st,
        actions: [{ type: "say" as const, text: `${first} ${state.phase === "told" ? LINES.anythingElse : REPROMPT[state.phase] ?? ""}`.trim() }],
      });
      // One miss gets a short answer and the question again; the second offers Sam.
      const miss = (first: string) =>
        heard.misses >= MAX_RETRIES
          ? handoff({ ...heard, misses: 0 }, "not_heard")
          : heard.misses >= 1
            ? { state: { ...heard, misses: heard.misses + 1 }, actions: [{ type: "say" as const, text: SECOND_TRY[state.phase] ?? LINES.offer }] }
            : reprompt({ ...heard, misses: heard.misses + 1 }, first);

      // Answers that win in any phase, said any way (free-form, not a fixed path).
      if (state.phase === "ask_contact") {
        const contact = normaliseContact(text);
        if (contact && state.orderNumber) {
          return {
            state: { ...heard, phase: "looking_up", misses: 0 },
            actions: [{ type: "lookup", orderNumber: state.orderNumber, contact: text }],
          };
        }
      }
      if (state.phase === "ask_name" && spokenDigits(text).length >= 3 && /[a-z]{2,}/i.test(text)) {
        return {
          state: { ...heard, phase: "looking_up", misses: 0, asked: addOnce(heard.asked, ASKED.status) },
          actions: [{ type: "lookup_by_name", text }],
        };
      }

      const intent = detectIntent(text);
      if (intent === "change") return handoff(heard, "change");
      if (intent === "person") return handoff(heard, "person");
      if (intent === "message") return handoff(heard, "message");
      if (intent === "hours") return reprompt(heard, SHOP_INFO.hours);
      if (intent === "location") return reprompt(heard, SHOP_INFO.where);
      if (intent === "no_number" && state.phase !== "ask_contact") {
        return {
          state: { ...heard, phase: "ask_name", misses: 0, orderNumber: null, asked: addOnce(heard.asked, ASKED.status) },
          actions: [{ type: "say", text: LINES.noNumber }],
        };
      }

      if (state.phase === "confirm_order") {
        const again = readOrderNumber(text);
        if (again && again.number !== state.orderNumber) {
          return {
            state: { ...heard, orderNumber: again.number },
            actions: [{ type: "say", text: LINES.confirmOrder(again.number) }],
          };
        }
        if (intent === "yes" || (again && again.number === state.orderNumber) || /\b(correct|right|that's it|yes)\b/i.test(text)) {
          return {
            state: { ...heard, phase: "ask_contact", misses: 0 },
            actions: [{ type: "say", text: LINES.askContact }],
          };
        }
        if (intent === "no") {
          return { state: { ...heard, phase: "ask_order", orderNumber: null }, actions: [{ type: "say", text: LINES.confirmAgain }] };
        }
        return miss("Sorry,");
      }

      if (state.phase === "told") {
        if (intent === "no") return finish(heard, LINES.bye);
        const reading = readOrderNumber(text);
        if (reading) return gotNumber(heard, reading);
        if (intent === "yes") {
          return {
            state: { ...heard, phase: "ask_order", orderNumber: null },
            actions: [{ type: "say", text: "Sure. What's the order number?" }],
          };
        }
        return { state: heard, actions: [{ type: "say", text: LINES.offer }] };
      }

      if (state.phase === "ask_order") {
        const reading = readOrderNumber(text);
        if (reading) return gotNumber(heard, reading);
        if (heard.misses >= MAX_RETRIES) return handoff({ ...heard, misses: 0 }, "not_heard");
        if (heard.misses >= 1) return { state: { ...heard, misses: heard.misses + 1 }, actions: [{ type: "say", text: SECOND_TRY.ask_order! }] };
        const wordy = text.trim().split(/\s+/).length > 3;
        return {
          state: { ...heard, misses: heard.misses + 1 },
          actions: [{ type: "say", text: wordy ? `${LINES.offTopic} ${LINES.askOrderAgain}` : LINES.askOrderAgain }],
        };
      }

      if (state.phase === "ask_name") return miss("");

      // ask_contact, but what we heard wasn't a phone number or email
      if (heard.misses >= MAX_RETRIES) return handoff({ ...heard, misses: 0 }, "not_heard");
      const again = heard.misses >= 1 ? SECOND_TRY.ask_contact! : LINES.askContactAgain;
      return { state: { ...heard, misses: heard.misses + 1 }, actions: [{ type: "say", text: again }] };
    }

    case "looking_up": {
      if (event.type !== "lookup_done") return { state, actions: [] };
      const result = event.result;
      if (result.match) {
        return {
          state: { ...state, phase: "told", failedLookups: 0, told: [...state.told, STATUS_WORDS[result.status].short] },
          actions: [
            { type: "say", text: result.say },
            { type: "say", text: LINES.anythingElse },
          ],
        };
      }
      const failed = state.failedLookups + 1;
      const told = addOnce(state.told, TOLD.noMatch);
      if (failed >= 2) return handoff({ ...state, failedLookups: failed, told }, "no_match");
      return {
        state: { ...state, phase: "ask_order", orderNumber: null, failedLookups: failed, told },
        actions: [{ type: "say", text: LINES.tryAgain }],
      };
    }

    case "ringing_owner": {
      if (event.type === "owner_answered") {
        const next = { ...state, ownerAnswered: true, told: addOnce(state.told, TOLD.putThrough), phase: "done" as const };
        return {
          state: next,
          actions: [
            { type: "say", text: LINES.connecting },
            { type: "connect_owner" },
            { type: "log", summary: summary(next) },
          ],
        };
      }
      if (event.type === "handed_to_phone") {
        const next = { ...state, phase: "done" as const };
        return { state: next, actions: [{ type: "log", summary: summary(next) }] };
      }
      if (event.type === "owner_no_answer") {
        return {
          state: { ...state, ownerAnswered: false, phase: "take_message" },
          actions: [{ type: "say", text: LINES.noAnswer }],
        };
      }
      return { state, actions: [] };
    }

    case "take_message": {
      if (event.type === "silence") {
        const next = { ...state, textedOwner: true, told: addOnce(state.told, TOLD.callBack) };
        const done = finish(next, LINES.noMessage);
        return { state: done.state, actions: [{ type: "text_owner", body: ownerText(next) }, ...done.actions] };
      }
      if (event.type !== "heard") return { state, actions: [] };
      const message = event.text.trim().slice(0, 500);
      const next = { ...state, message, textedOwner: true, told: addOnce(state.told, TOLD.callBack) };
      const done = finish(next, LINES.messageTaken);
      return { state: done.state, actions: [{ type: "text_owner", body: ownerText(next) }, ...done.actions] };
    }

    default:
      return { state, actions: [] };
  }
}
