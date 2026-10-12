import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openCallLog } from "../src/phone/calllog.ts";
import { LINES, MAX_RETRIES, TOLD, detectIntent } from "../src/phone/flow.ts";
import { lookupByName, lookupOrder } from "../src/phone/lookup.ts";
import { readOrderNumber, sayDigits } from "../src/phone/normalise.ts";
import { sampleOrderSource } from "../src/phone/orders.ts";
import { CallSession } from "../src/phone/session.ts";
import { SHOP_INFO } from "../src/phone/shopinfo.ts";

async function call(turns: string[], owner: "answered" | "no_answer" = "no_answer") {
  const orders = sampleOrderSource();
  const said: string[] = [];
  const log = openCallLog();
  let rang = 0;
  const session = new CallSession({
    telephony: {
      say: (t) => void said.push(t),
      ringOwner: async () => {
        rang += 1;
        return owner;
      },
      connectOwner: () => {},
      hangUp: () => {},
    },
    sms: { async send() {} },
    lookup: (o, c) => lookupOrder(orders, o, c),
    lookupByName: (t) => lookupByName(orders, t),
    log,
    ownerTextTo: "0491570110",
  });
  await session.start("0491570156");
  for (const t of turns) {
    if (session.phase === "done") break;
    await session.heard(t);
  }
  const phase = session.phase;
  if (phase !== "done") await session.hungUp();
  return { said, rang, session: { phase }, log };
}

describe("phone line: spoken order numbers", () => {
  const forms: Array<[string, boolean]> = [
    ["a thousand and forty-two", false],
    ["A thousand and forty-two is my number.", false],
    ["one thousand forty two", false],
    ["one thousand and forty two", false],
    ["ten forty-two", false],
    ["ten forty two", false],
    ["a thousand and 42", false],
    ["1 thousand 42", false],
    ["one zero four two", true],
    ["one oh four two", true],
    ["It's order 1042", true],
    ["order #1042", true],
  ];
  for (const [said, sure] of forms) {
    it(`"${said}" -> 1042${sure ? "" : " (read back first)"}`, () => {
      assert.deepEqual(readOrderNumber(said), { number: "1042", sure });
    });
  }
  it("ignores things that aren't numbers", () => {
    assert.equal(readOrderNumber("Can I talk to Sam?"), null);
    assert.equal(readOrderNumber("I don't have the number"), null);
    assert.equal(readOrderNumber("a long black please"), null);
  });
  it("reads numbers back digit by digit", () => {
    assert.equal(sayDigits("1042"), "one-oh-four-two");
  });
});

describe("phone line: read-back before lookup", () => {
  it("confirms an unsure number, then carries on", async () => {
    const { said } = await call(["A thousand and forty-two is my number.", "Yes", "0491 570 156", "No thanks"]);
    assert.equal(said[1], "Is that order one-oh-four-two?");
    assert.equal(said[2], LINES.askContact);
    assert.match(said.join(" "), /on its way/i);
  });
  it("a corrected number is read back again", async () => {
    const { said } = await call(["ten forty-one", "No, ten forty-two"]);
    assert.equal(said.at(-1), "Is that order one-oh-four-two?");
  });
  it("'no' asks for the number again", async () => {
    const { said, session } = await call(["ten forty-two", "No"]);
    assert.equal(said.at(-1), LINES.confirmAgain);
    assert.equal(session.phase, "ask_order");
  });
  it("a sure number skips the read-back", async () => {
    const { said } = await call(["one oh four two"]);
    assert.equal(said[1], LINES.askContact);
  });
});

describe("phone line: detours", () => {
  it("asking for a person at any point goes to Sam", async () => {
    const { said, rang } = await call(["ten forty-two", "Actually can I speak to someone?"]);
    assert.ok(said.includes(LINES.handoffPerson));
    assert.equal(rang, 1);
  });
  it("opening hours: short answer from the sample config, then back to the question", async () => {
    const { said, session } = await call(["What time do you close today?"]);
    assert.ok(said[1]!.startsWith(SHOP_INFO.hours));
    assert.equal(session.phase, "ask_order");
    assert.match(said[1]!, /order number/);
  });
  it("location: Australia-level wording only", async () => {
    const { said } = await call(["Where are you located?"]);
    assert.ok(said[1]!.startsWith(SHOP_INFO.where));
    assert.doesNotMatch(SHOP_INFO.where, /\d|street|st\b|road|rd\b/i);
  });
  it("unknown order: tries once more, then passes to Sam", async () => {
    const { said, rang } = await call(["1099", "0491 570 156", "1098", "0491 570 156"]);
    assert.ok(said.some((l) => l.startsWith("Sorry, I couldn't match")));
    assert.ok(said.includes(LINES.handoffNoMatch));
    assert.equal(rang, 1);
  });
  it("no order number: finds it by first name and last 3 phone digits", async () => {
    const { said } = await call(["I don't have the order number", "It's Ari, one five six"]);
    assert.equal(said[1], LINES.noNumber);
    assert.match(said[2]!, /on its way/i);
  });
  it("no order number, wrong details: never says which part was wrong", async () => {
    const { said } = await call(["I lost my receipt and don't know the number", "It's Ari, nine nine nine"]);
    assert.ok(said[2]!.startsWith("Sorry, I couldn't match"));
  });
  it("no order number: can choose a message instead", async () => {
    const { said, rang } = await call(["I don't have the number", "I'll just leave a message"]);
    assert.ok(said.includes(LINES.handoffMessage));
    assert.equal(rang, 1);
  });
  it("off-topic: brief answer and the question again, then offers Sam", async () => {
    const { said, rang } = await call(["Do you sell gift cards for birthdays?", "What about catering for a party?", "And do you have parking out the front?"]);
    assert.ok(said[1]!.startsWith(LINES.offTopic));
    assert.ok(said.includes(LINES.handoffNotHeard));
    assert.equal(rang, 1);
  });
  it("change requests are still handed over, never done", async () => {
    const { said, log } = await call(["1042", "0491 570 156", "Can you cancel it?"]);
    assert.ok(said.includes(LINES.handoffChange));
    assert.ok(log.list()[0]!.told.includes(TOLD.putThrough));
  });
  it("intents are free-form", () => {
    assert.equal(detectIntent("are you open on saturday"), "hours");
    assert.equal(detectIntent("what's your address"), "location");
    assert.equal(detectIntent("I can't find the order number anywhere"), "no_number");
    assert.equal(detectIntent("could I leave a voicemail"), "message");
  });
});

describe("phone line: Nate's check call, replayed", () => {
  it('"A thousand and forty-two is my number." no longer misses', async () => {
    const { said } = await call(["A thousand and forty-two is my number."]);
    assert.notEqual(said[1], LINES.askOrderAgain);
    assert.equal(said[1], "Is that order one-oh-four-two?");
  });
});

describe("phone line: never repeats itself", () => {
  const noRepeats = (said: string[]) => {
    for (let i = 1; i < said.length; i += 1) assert.notEqual(said[i], said[i - 1], `repeated: ${said[i]}`);
  };
  it("misheard order numbers: two different re-prompts, then voicemail", async () => {
    const { said, rang } = await call(["blah", "mumble", "hmm what"]);
    assert.equal(MAX_RETRIES, 2);
    noRepeats(said);
    assert.notEqual(said[1], said[2]);
    assert.ok(said.includes(LINES.handoffNotHeard));
    assert.equal(rang, 1);
  });
  it("misheard contact: two different re-prompts, then voicemail", async () => {
    const { said, rang } = await call(["1042", "um", "er", "no idea"]);
    noRepeats(said);
    assert.equal(rang, 1);
  });
  it("call 2 replay (Nate, 12 Oct): no sentence said twice in a row, and the number is understood", async () => {
    const { said } = await call([
      "Account number 42",
      "A thousand and forty-two",
      "I said yes it was, one thousand and forty-two.",
      "0 4 triple 3",
      "0 4 triple 3 4 7 1 double 9",
      "Zero",
    ]);
    noRepeats(said);
    assert.ok(said.includes("Is that order one-oh-four-two?"));
    assert.ok(said.includes(LINES.askContact));
  });
  it("greeting is short (under 4 s at a normal pace of ~2.7 words/s)", () => {
    assert.ok(LINES.greet.split(/\s+/).length / 2.7 < 4, LINES.greet);
  });
});
