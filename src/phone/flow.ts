import { normaliseContact, normaliseOrderNumber } from "./normalise.ts";
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

export const LINES = {
  greet: `Hi, you've reached ${SHOP_NAME}. I can tell you where your order is. What's your order number? You can also say "talk to ${OWNER_NAME}" at any time.`,
  askOrderAgain: "Sorry, I didn't catch that. What's the order number?",
  askContact: "Thanks. And what's the mobile number or email on the order?",
  askContactAgain: "Sorry, I didn't catch that. What's the mobile number or email you used for the order?",
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

export type HandoffReason = "change" | "person" | "no_match" | "not_heard";

export type Phase =
  | "idle"
  | "ask_order"
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
};

export type FlowEvent =
  | { type: "call_started"; caller: string }
  | { type: "heard"; text: string }
  | { type: "silence" }
  | { type: "lookup_done"; result: LookupResult }
  | { type: "owner_answered" }
  | { type: "owner_no_answer" }
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
  | { type: "ring_owner" }
  | { type: "connect_owner" }
  | { type: "text_owner"; body: string }
  | { type: "hang_up" }
  | { type: "log"; summary: CallSummary };

/** Every action type the flow can produce. None of them writes to an order. */
export const ACTION_TYPES: readonly FlowAction["type"][] = [
  "say",
  "lookup",
  "ring_owner",
  "connect_owner",
  "text_owner",
  "hang_up",
  "log",
];

export type Intent = "change" | "person" | "no" | "yes" | "none";

const CHANGE =
  /\b(change|changing|cancel|cancelling|canceling|refund|swap|switch|modify|amend|edit|update|wrong (item|order|thing)|instead|different address|add (a|an|another|one|some)|remove|take off)\b/i;
const PERSON =
  /\b(talk|speak|chat)\b[^.?!]*\b(someone|somebody|person|human|sam|owner|staff|manager|real|anyone)\b|\b(real person|a human|operator|representative|put me through|call me back|talk to sam|speak to sam)\b/i;
const NO = /^\s*(no|nope|nah|no thanks|no thank you)\b|\b(that's all|that is all|that's it|nothing else|all good|bye|goodbye)\b/i;
const YES = /^\s*(yes|yeah|yep|yup|sure|please)\b|\b(another order|check another|one more)\b/i;

export function detectIntent(text: string): Intent {
  if (CHANGE.test(text)) return "change";
  if (PERSON.test(text)) return "person";
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
        : reason === "no_match"
          ? LINES.handoffNoMatch
          : LINES.handoffNotHeard;
  let asked = state.asked;
  if (reason === "change") asked = addOnce(asked, ASKED.change);
  if (reason === "person") asked = addOnce(asked, ASKED.person);
  if (asked.length === 0) asked = [ASKED.status];
  return {
    state: { ...state, phase: "ringing_owner", handedOver: true, handoffReason: reason, asked, silences: 0 },
    actions: [{ type: "say", text: line }, { type: "ring_owner" }],
  };
}

function ownerText(state: FlowState): string {
  const wanted =
    state.handoffReason === "change"
      ? "wants to change an order"
      : state.handoffReason === "person"
        ? "asked to talk to you"
        : state.handoffReason === "no_match"
          ? "asked about an order, but the details didn't match"
          : "called, but the line was hard to hear";
  const who = state.caller ? `Missed call from ${state.caller}` : "Missed call (no caller number)";
  const order = state.orderNumber ? ` about order ${state.orderNumber}` : "";
  const message = state.message ? ` Message: "${state.message}"` : " No message left.";
  return `${SHOP_NAME} line. ${who}${order}. They ${wanted}.${message} Please call them back.`;
}

const REPROMPT: Partial<Record<Phase, string>> = {
  ask_order: LINES.askOrderAgain,
  ask_contact: LINES.askContactAgain,
  told: LINES.anythingElse,
};

export function step(state: FlowState, event: FlowEvent): { state: FlowState; actions: FlowAction[] } {
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
    case "ask_contact":
    case "told": {
      if (event.type === "silence") {
        if (state.silences >= 1) return finish(state, LINES.bye);
        return {
          state: { ...state, silences: state.silences + 1 },
          actions: [{ type: "say", text: `${LINES.stillThere} ${REPROMPT[state.phase] ?? ""}`.trim() }],
        };
      }
      if (event.type !== "heard") return { state, actions: [] };
      const heard = { ...state, silences: 0 };
      const text = event.text;

      if (state.phase === "ask_contact") {
        const contact = normaliseContact(text);
        if (contact && state.orderNumber) {
          return {
            state: { ...heard, phase: "looking_up", misses: 0 },
            actions: [{ type: "lookup", orderNumber: state.orderNumber, contact: text }],
          };
        }
      }

      const intent = detectIntent(text);
      if (intent === "change") return handoff(heard, "change");
      if (intent === "person") return handoff(heard, "person");

      if (state.phase === "told") {
        if (intent === "no") return finish(heard, LINES.bye);
        if (intent === "yes" || normaliseOrderNumber(text)) {
          const number = normaliseOrderNumber(text);
          if (number) {
            return {
              state: { ...heard, phase: "ask_contact", orderNumber: number, asked: addOnce(heard.asked, ASKED.status) },
              actions: [{ type: "say", text: LINES.askContact }],
            };
          }
          return {
            state: { ...heard, phase: "ask_order", orderNumber: null },
            actions: [{ type: "say", text: "Sure. What's the order number?" }],
          };
        }
        return { state: heard, actions: [{ type: "say", text: LINES.offer }] };
      }

      if (state.phase === "ask_order") {
        const number = normaliseOrderNumber(text);
        if (number) {
          return {
            state: { ...heard, phase: "ask_contact", orderNumber: number, misses: 0, asked: addOnce(heard.asked, ASKED.status) },
            actions: [{ type: "say", text: LINES.askContact }],
          };
        }
        if (heard.misses >= 1) return handoff({ ...heard, misses: 0 }, "not_heard");
        return { state: { ...heard, misses: heard.misses + 1 }, actions: [{ type: "say", text: LINES.askOrderAgain }] };
      }

      // ask_contact, but what we heard wasn't a phone number or email
      if (heard.misses >= 1) return handoff({ ...heard, misses: 0 }, "not_heard");
      return { state: { ...heard, misses: heard.misses + 1 }, actions: [{ type: "say", text: LINES.askContactAgain }] };
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
