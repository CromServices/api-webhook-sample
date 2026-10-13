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
  ask_contact: "Could you say the mobile one digit at a time, or spell out the email?",
  ask_name: "Just your first name, then the last three digits of your phone, please.",
  confirm_order: "Was that the right order number? Yes or no is fine.",
  told: "Anything else? You can check another order or ask for Sam.",
};

export const LINES = {
  // Under 4 seconds spoken. Detours (Sam, hours, no number) work without being listed.
  greet: `Hi, it's ${SHOP_NAME}. What's your order number?`,
  /** The caller's first words were just "hello?": greet again, not counted as a miss. */
  greetAgain: `Hi there, you're through to ${SHOP_NAME}. What's your order number?`,
  /** First no-match: keep the order, ask for the contact again, offer the name lookup. */
  noMatchHint: (n: string) =>
    `That contact doesn't match the details on order ${sayDigits(n)}. What's the mobile or email on that order? Or your first name and the last three digits of your phone?`,
  orderRequest: `I can't place orders, but I'll pass it to ${OWNER_NAME}.`,
  askOrderAgain: "Sorry, I missed that. What's the order number?",
  askContact: "Thanks. And what's the mobile number or email on the order?",
  askContactAgain: "Sorry, I missed that. What's the mobile or email on the order?",
  tryAgain: `${NO_MATCH_SAY} Let's try once more. What's the order number?`,
  anythingElse: "Is there anything else I can help with?",
  offer: `I can check another order, or put you through to ${OWNER_NAME}. Which would you like?`,
  handoffChange: `I can't change orders myself, but ${OWNER_NAME} can. I'll put you through now.`,
  handoffPerson: `No problem, I'll put you through to ${OWNER_NAME} now.`,
  handoffNoMatch: `That still doesn't match the details on the order, so I'll put you through to ${OWNER_NAME}.`,
  /** Never blames the caller (or their phone). */
  handoffNotHeard: `Let me put you through to ${OWNER_NAME}, who can help.`,
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
  offTopic: `Sorry, I can only check orders on this line, but I can take a message for ${OWNER_NAME}. Want me to?`,
  /** New orders, buying, or anything that isn't checking an order: offer a message, never a re-prompt. */
  otherRequest: `I can't take new orders or other requests on this line, but I can take a message for ${OWNER_NAME}. Want me to?`,
  offerAgain: `Shall I take a message for ${OWNER_NAME}? Just yes or no.`,
  handoffComplaint: `Sorry about that. ${OWNER_NAME} can sort it out, so I'll put you through.`,
  statusAsk: "Sure, I can check that. What's the order number?",
  confirmYesNo: (n: string) => `Is that order ${sayDigits(n)}? Just yes or no.`,
  handoffMessage: `No worries, I'll pass you to ${OWNER_NAME}'s voicemail so you can get a call back.`,
} as const;

/** Plain words for the call log. */
export const ASKED = {
  status: "Where's my order",
  change: "To change an order",
  person: `To talk to ${OWNER_NAME}`,
  orderRequest: `To place an order (request for ${OWNER_NAME})`,
} as const;

export const TOLD = {
  noMatch: "Couldn't match the details",
  putThrough: `Put through to ${OWNER_NAME}`,
  callBack: `${OWNER_NAME} will call back`,
} as const;

export type HandoffReason = "change" | "complaint" | "person" | "message" | "no_match" | "not_heard";

/** Behaviour switches, off by default until tried on a live call. */
export type FlowFlags = {
  /** Silence after "Is that order …?" repeats the yes/no question instead of asking for the number again. */
  confirmReask?: boolean;
};

export type Phase =
  | "idle"
  | "ask_order"
  | "confirm_order"
  | "ask_name"
  | "ask_contact"
  | "looking_up"
  | "told"
  | "offer_message"
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
  flags?: FlowFlags;
  /** Where to go back to if the caller says no to leaving a message. */
  returnPhase?: Phase;
  /** True once anything has been heard from the caller. */
  heardAny?: boolean;
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
  | { type: "lookup_by_name"; text: string; /** Confirmed order: only this one may match. */ orderNumber?: string | null }
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

export type Intent =
  | "order_request"
  | "change"
  | "complaint"
  | "person"
  | "message"
  | "hours"
  | "location"
  | "no_number"
  | "status"
  | "no"
  | "yes"
  | "none";

/** Wants to place a (new) order. The line never places orders; it passes the request to Sam. */
export const ORDER_REQUEST =
  /\b((raise|create|start|open|do|make|place|put in|book) (an|a|another|a new|one more|new)( \w+)? (order|one)|another order|new one|(i'?d|i would|i want to|i wanna|want to|wanna|can i|could i|i'?d like to|like to|need to) (buy|purchase|get|book)\b|buy (something|some|a|an|another|more|stuff)|(\d+|two|three|four|five|six|seven|eight|nine|ten|a dozen) (coffees|pizzas?|dogs?|puppies|items)|pizza|dogs?|puppy|plumb(ing|er)|electrician|tradie|repairs?|order me|orders? (me )?something|place (an|a|a new|another) order|make (an|a|another) order|put (in|through) (an|a|another) order|new order|(can|could|may) i (order|get an order)|(i'?d|i would|i'?ll|i want to|i wanna|want to|wanna) (like to )?order\b|(get|have) (sam|him|her|someone) (to )?order|take (an|my) order)\b/i;

const CHANGE =
  /\b(change|changing|cancel+(ing|ed)?|refund|swap|switch|modify(ing)?|amend|edit|updat(e|ing)|instead|different address|add (a|an|another|one|some)|remove|take off|scrap (that|it|my)|don'?t (need|want) (it|that|the order)|money back)\b/i;
const COMPLAINT =
  /\b(wrong|missing|forgot(ten)?|left out|didn'?t (get|receive|come|arrive)|never (got|arrived|came)|hasn'?t (arrived|come)|not (arrived|received|here)|broken|damaged|crushed|incomplete|reimburs\w*|spilt|spilled|stone cold|cold|complain(t)?|problem|issue|not happy|terrible|disgusting|report)\b/i;
const PERSON =
  /\b(talk|speak|chat|yarn)\b[^.?!]*\b(someone|somebody|person|human|sam|owner|staff|manager|real|anyone|boss|agent|service|support)\b|\b(real person|a human|operator|representative|put me (through|onto|on to)|call me back|give me a (bell|call|ring)|talk to sam|speak to sam|is sam (around|there|in)|customer (service|support|care)|client (service|support)|(contact|call|email|reach|ring) (the )?(owner|boss|sam|agent|support|staff|someone)|live agent|human agent|an agent|(send|put|get|transfer) me (to|through to|onto|on to) (sam|the owner|someone|a person))\b/i;
const MESSAGE = /\b(leave (a |him |her |them )?(message|voicemail)|voicemail|take a message|message)\b/i;
const HOURS = /\b(open|opening|close|closing|shut|hours|what time (do|are|does)|when do you|trading)\b/i;
const LOCATION =
  /\b(where are (you|ya|youse)|whereabouts|where('s| is) (the |your )?(shop|cafe|café|store|place)|where (do|can) i (pick|collect|find|get)|pick (it|my order|it all) up from|your address|the address|location|located|directions|find you|(nearest|closest|nearby) (store|shop|cafe)s?|stores? (near|nearby|close|in my area)|(find|search for|looking for) (a |the )?(store|shop)s?)\b/i;
const STATUS_WHAT = /\b(order|orders|delivery|package|parcel|purchase|food|coffee|brekkie|breakfast|item|items|it|stuff|shipment|replacement|exchange)\b/i;
const STATUS_ASK =
  /\b(where|track|tracking|status|eta|how long|when|ready|on (its|the) way|sent|dispatch(ed)?|ship(ped|ping)?|arriv(e|ing|al)|deliver(ed|ing|y)?|coming|here yet|at\??$|check(ing)? (on|up)|update on|progress)\b/i;
const NO_NUMBER =
  /\b(don'?t|do not|can'?t|cannot|didn'?t|never) (have|know|remember|find|get|got|see)\b[^.?!]*\b(number|receipt)\b|\b(lost|forgot|no idea)\b[^.?!]*\b(number|receipt)\b|\bno (order )?number\b|\blost (the|my) receipt\b/i;
const NO =
  /^\s*(no|nope|nah)\s*[.,!]?\s*$|^\s*(no|nope|nah)\b[ ,]*(thanks|thank you|that's all|that is all|all good|i'm good|cheers|that's it)|\byeah,? nah\b|\b(that's all|that is all|nothing else|bye|goodbye)\b/i;
const YES = /^\s*(yes|yeah|yep|yup|sure|please(?! \w+ the)|correct|right|exactly|too right|spot on|that's right|that's it|you got it|bang on)\b|\b(another order|check another|one more|that's (right|correct))\b/i;

export function detectIntent(text: string): Intent {
  if (NO_NUMBER.test(text)) return "no_number";
  if (ORDER_REQUEST.test(text) && !/\b(check|track|status|where|update on)\b/i.test(text) && !/\b(my|the|that|this) order\b/i.test(text.replace(ORDER_REQUEST, ""))) return "order_request";
  if (CHANGE.test(text)) return "change";
  if (COMPLAINT.test(text)) return "complaint";
  if (PERSON.test(text)) return "person";
  if (MESSAGE.test(text)) return "message";
  if (LOCATION.test(text)) return "location";
  if (HOURS.test(text)) return "hours";
  if (NO.test(text)) return "no";
  if (STATUS_ASK.test(text) && STATUS_WHAT.test(text)) return "status";
  if (YES.test(text)) return "yes";
  return "none";
}

export function initialState(flags: FlowFlags = {}): FlowState {
  return {
    flags,
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
      : reason === "complaint"
        ? LINES.handoffComplaint
        : reason === "person"
        ? LINES.handoffPerson
        : reason === "message"
          ? LINES.handoffMessage
          : reason === "no_match"
          ? LINES.handoffNoMatch
          : LINES.handoffNotHeard;
  let asked = state.asked;
  if (reason === "change" || reason === "complaint") asked = addOnce(asked, ASKED.change);
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
        : state.handoffReason === "complaint"
          ? "have a problem with an order"
        : state.handoffReason === "message"
          ? "wanted to leave a message"
          : state.handoffReason === "no_match"
          ? "asked about an order, but the details didn't match"
          : "called, but the line was hard to hear";
  const who = state.caller ? `Missed call from ${spaced(state.caller)}` : "Missed call (no caller number)";
  const order = state.orderNumber ? ` about order ${state.orderNumber}` : "";
  const wantsOrder = state.asked.includes(ASKED.orderRequest) ? " They also want to place an order (the line can't take orders)." : "";
  const message = state.message ? ` Message: "${state.message}"` : " No message left.";
  return `${SHOP_NAME} line. ${who}${order}. They ${wanted}.${wantsOrder}${message} Please call them back.`;
}

const REPROMPT: Partial<Record<Phase, string>> = {
  ask_order: LINES.askOrderAgain,
  confirm_order: LINES.confirmAgain,
  ask_name: LINES.askNameAgain,
  ask_contact: LINES.askContactAgain,
  told: LINES.anythingElse,
};

export const HELLO_ONLY =
  /^\W*(hello|hi|hey|hiya|g'?day|yeah|yes|hello,? (hello|who'?s (this|that)|who is (this|it))|who'?s (this|calling)|who is this)\W*(\W+(hello|hi|yeah|there))*\W*$/i;

/** The bare question for a phase: no "sorry", so nothing stacks. */
const QUESTION: Partial<Record<Phase, string>> = {
  ask_order: "What's the order number?",
  confirm_order: "Was that the right order number?",
  ask_name: "What's the first name on the order, and the last three digits of your phone?",
  ask_contact: "What's the mobile or email on the order?",
  told: "Is there anything else I can help with?",
};

/** A refusal or new request: offer a message for Sam (yes or silence -> voicemail, no -> back). */
function offerMessage(state: FlowState, back: Phase, line: string) {
  const returnPhase = back === "offer_message" ? state.returnPhase ?? "ask_order" : back;
  return { state: { ...state, phase: "offer_message" as const, returnPhase, misses: 0 }, actions: [{ type: "say" as const, text: line }] };
}

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
        if (state.phase === "confirm_order" && state.flags?.confirmReask && state.orderNumber && state.silences < 1) {
          return {
            state: { ...state, silences: state.silences + 1 },
            actions: [{ type: "say", text: LINES.confirmYesNo(state.orderNumber) }],
          };
        }
        // Reprompt once, then offer Sam's voicemail rather than stall or hang up.
        if (state.silences >= 1) return handoff({ ...state, silences: 0 }, "not_heard");
        return {
          state: { ...state, silences: state.silences + 1 },
          actions: [{ type: "say", text: `${LINES.stillThere} ${QUESTION[state.phase] ?? ""}`.trim() }],
        };
      }
      if (event.type !== "heard") return { state, actions: [] };
      const heard = { ...state, silences: 0, heardAny: true };
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

      // First thing heard is just "hello?" (outbound calls, or talking over the greeting): greet again, no miss.
      if (state.phase === "ask_order" && !state.heardAny && HELLO_ONLY.test(text)) {
        return { state: heard, actions: [{ type: "say", text: LINES.greetAgain }] };
      }

      // Answers that win in any phase, said any way (free-form, not a fixed path).
      if (state.phase === "ask_contact" && state.failedLookups > 0 && state.orderNumber) {
        // After a no-match the caller may give first name + last 3 digits instead (the hint offers it).
        // 3 digits + a name: the name lookup. 4 to 6 digits: a different order number.
        const d = spokenDigits(text);
        const rest = text.replace(
          /\b(it'?s|its|my|name|is|and|the|last|three|digits|of|phone|mobile|number|sorry|no|yes|yeah|um|uh|oh|actually|zero|one|two|four|five|six|seven|eight|nine|double|triple|i'?m|am|this)\b/gi,
          "",
        );
        if (d.length === 3 && /\b[a-z]{2,}\b/i.test(rest)) {
          return {
            state: { ...heard, phase: "looking_up", misses: 0 },
            actions: [{ type: "lookup_by_name", text, orderNumber: state.orderNumber }],
          };
        }
        const other = d.length >= 4 && d.length <= 6 ? readOrderNumber(text) : null;
        if (other && other.number !== state.orderNumber) return gotNumber(heard, other);
      }
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
      if (intent === "order_request") {
        return offerMessage({ ...heard, asked: addOnce(heard.asked, ASKED.orderRequest) }, state.phase, LINES.otherRequest);
      }
      if (intent === "change") return handoff(heard, "change");
      if (intent === "complaint") return handoff(heard, "complaint");
      if (intent === "person") return handoff(heard, "person");
      if (intent === "message") return handoff(heard, "message");
      if (intent === "hours") return reprompt(heard, SHOP_INFO.hours);
      if (intent === "location") return reprompt(heard, SHOP_INFO.where);
      if (intent === "no_number" && (state.phase !== "ask_contact" || state.failedLookups > 0)) {
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
        if (intent === "yes" || intent === "status") {
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
        if (intent === "status" && !heard.asked.includes(ASKED.status)) {
          return { state: { ...heard, asked: addOnce(heard.asked, ASKED.status) }, actions: [{ type: "say", text: LINES.statusAsk }] };
        }
        if (heard.misses >= MAX_RETRIES) return handoff({ ...heard, misses: 0 }, "not_heard");
        if (heard.misses >= 1) return { state: { ...heard, misses: heard.misses + 1 }, actions: [{ type: "say", text: SECOND_TRY.ask_order! }] };
        const wordy = text.trim().split(/\s+/).length > 3;
        // Off-topic: a refusal is its own turn (offer a message), never glued to a re-prompt.
        if (wordy) return offerMessage({ ...heard, misses: heard.misses + 1 }, "ask_order", LINES.offTopic);
        return { state: { ...heard, misses: heard.misses + 1 }, actions: [{ type: "say", text: LINES.askOrderAgain }] };
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
      if (result.ambiguous) return handoff({ ...state, told: addOnce(state.told, TOLD.noMatch) }, "no_match");
      const failed = state.failedLookups + 1;
      const told = addOnce(state.told, TOLD.noMatch);
      if (failed >= 2) return handoff({ ...state, failedLookups: failed, told }, "no_match");
      // Keep the confirmed order: ask for the contact again and offer the name + last-3 lookup.
      if (state.orderNumber) {
        return {
          state: { ...state, phase: "ask_contact", misses: 0, failedLookups: failed, told },
          actions: [{ type: "say", text: LINES.noMatchHint(state.orderNumber) }],
        };
      }
      return {
        state: { ...state, phase: "ask_order", orderNumber: null, failedLookups: failed, told },
        actions: [{ type: "say", text: LINES.tryAgain }],
      };
    }

    case "offer_message": {
      const back = state.returnPhase ?? "ask_order";
      if (event.type === "silence") return handoff({ ...state, returnPhase: undefined }, "message");
      if (event.type !== "heard") return { state, actions: [] };
      const heard = { ...state, silences: 0, heardAny: true };
      const intent = detectIntent(event.text);
      const yes = intent === "yes" || intent === "message" || intent === "person" || /\b(yes|yeah|yep|please|sure|ok(ay)?|go on|do that)\b/i.test(event.text);
      const no = intent === "no" || /^\W*(no|nope|nah)\b/i.test(event.text);
      if (no && !yes) {
        return {
          state: { ...heard, phase: back, returnPhase: undefined, misses: 0 },
          actions: [{ type: "say", text: `No problem. ${QUESTION[back] ?? ""}`.trim() }],
        };
      }
      if (yes || intent === "order_request" || heard.misses >= 1) return handoff({ ...heard, returnPhase: undefined, misses: 0 }, "message");
      return { state: { ...heard, misses: heard.misses + 1 }, actions: [{ type: "say", text: LINES.offerAgain }] };
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
      const wantsOrder = detectIntent(message) === "order_request" || ORDER_REQUEST.test(message);
      const next = {
        ...state,
        message,
        textedOwner: true,
        told: addOnce(state.told, TOLD.callBack),
        asked: wantsOrder ? addOnce(state.asked, ASKED.orderRequest) : state.asked,
      };
      const done = finish(next, wantsOrder ? `${LINES.orderRequest} ${LINES.messageTaken}` : LINES.messageTaken);
      return { state: done.state, actions: [{ type: "text_owner", body: ownerText(next) }, ...done.actions] };
    }

    default:
      return { state, actions: [] };
  }
}
