/**
 * Scripted calls shared by the tests and the call log screenshot. Mock phone,
 * mock texts, real flow, real read-only lookup on the sample order book.
 */
import { openCallLog, type CallLog } from "../src/phone/calllog.ts";
import { lookupOrder } from "../src/phone/lookup.ts";
import { sampleOrderSource, type OrderSource } from "../src/phone/orders.ts";
import { CallSession, type Telephony } from "../src/phone/session.ts";

export type Turn = { heard: string } | { silence: true } | { hangUp: true };

export type Script = {
  name: string;
  caller: string;
  owner: "answered" | "no_answer";
  turns: Turn[];
  /** Seconds the call takes, for the log's times. */
  seconds: number;
};

export type Ran = {
  said: string[];
  texts: { to: string; body: string }[];
  rang: number;
  connected: boolean;
  hungUp: boolean;
  session: CallSession;
};

/** Never a real person's number: ACMA's fiction range. */
export const TEST_OWNER_TEXT_TO = "0491570110";

export const SCRIPTS: Script[] = [
  {
    name: "happy path",
    caller: "0491570156",
    owner: "answered",
    seconds: 48,
    turns: [{ heard: "It's order 1042" }, { heard: "0491 570 156" }, { heard: "No, that's all, thanks" }],
  },
  {
    name: "wrong order number",
    caller: "0491570313",
    owner: "no_answer",
    seconds: 95,
    turns: [
      { heard: "1099" },
      { heard: "0491 570 313" },
      { heard: "Sorry, 1098" },
      { heard: "0491 570 313" },
      { heard: "Hi Sam, it's Priya. I think I've got the wrong order number, can you call me back?" },
    ],
  },
  {
    name: "change request",
    caller: "0491570157",
    owner: "answered",
    seconds: 41,
    turns: [{ heard: "1045" }, { heard: "dom.p@example.com" }, { heard: "Can I change it to a long black instead?" }],
  },
  {
    name: "ask for a person",
    caller: "0491570737",
    owner: "answered",
    seconds: 19,
    turns: [{ heard: "Can I just talk to someone please?" }],
  },
  {
    name: "owner doesn't answer",
    caller: "0855501234",
    owner: "no_answer",
    seconds: 73,
    turns: [
      { heard: "I need to cancel my banana bread order" },
      { heard: "Hi, it's Mel. Please cancel my banana bread, I can't make it in today. Thanks." },
    ],
  },
];

export async function runScript(
  script: Script,
  opts: { log?: CallLog; orders?: OrderSource; startAt?: Date } = {},
): Promise<Ran> {
  const orders = opts.orders ?? sampleOrderSource();
  const log = opts.log ?? openCallLog();
  const said: string[] = [];
  const texts: { to: string; body: string }[] = [];
  let rang = 0;
  let connected = false;
  let hungUp = false;
  const start = opts.startAt ?? new Date("2026-10-10T01:00:00Z");
  let clock = start.getTime();
  const telephony: Telephony = {
    say(text) {
      said.push(text);
    },
    async ringOwner() {
      rang += 1;
      return script.owner;
    },
    connectOwner() {
      connected = true;
    },
    hangUp() {
      hungUp = true;
    },
  };
  const session = new CallSession({
    telephony,
    sms: {
      async send(to, body) {
        texts.push({ to, body });
      },
    },
    lookup: (orderNumber, contact) => lookupOrder(orders, orderNumber, contact),
    log,
    ownerTextTo: TEST_OWNER_TEXT_TO,
    now: () => new Date(clock),
  });
  await session.start(script.caller);
  const tick = (script.seconds * 1000) / script.turns.length;
  for (const turn of script.turns) {
    if (session.phase === "done") break;
    clock += tick;
    if ("heard" in turn) await session.heard(turn.heard);
    else if ("silence" in turn) await session.silence();
    else await session.hungUp();
  }
  if (session.phase !== "done") await session.hungUp();
  return { said, texts, rang, connected, hungUp, session };
}
