/** Regression tests fed by scripts/transcript-loop.ts from real (masked) call transcripts. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { openCallLog } from "../../src/phone/calllog.ts";
import { lookupByName, lookupOrder } from "../../src/phone/lookup.ts";
import { sampleOrderSource } from "../../src/phone/orders.ts";
import { CallSession } from "../../src/phone/session.ts";
import { score, type Row } from "../../scripts/phone/eval-intents.ts";
import { maskPhones, findIssues, parseTrace, type CallTurn } from "../../scripts/phone/transcript-loop.ts";

const turns: CallTurn[] = JSON.parse(readFileSync(new URL("./fixtures/call-turns.json", import.meta.url), "utf8"));
// Small made-up phrase set in the repo; the fuller internal list loads only when PHRASES_AU_PATH points at it (kept out of this repo).
const au: Row[] = [
  ...JSON.parse(readFileSync(new URL("./fixtures/phrases-sample.json", import.meta.url), "utf8")),
  ...(process.env.PHRASES_AU_PATH && existsSync(process.env.PHRASES_AU_PATH) ? JSON.parse(readFileSync(process.env.PHRASES_AU_PATH, "utf8")) : []),
];

describe("phone line: real call turns (regression)", () => {
  it("never holds a real caller number", () => {
    for (const t of turns) assert.doesNotMatch(t.text, /0?4\s?33\s?347|347\s?199/);
  });
  for (const t of turns.filter((x) => x.expect)) {
    it(`${t.call} +${t.t}s understood: "${t.text}"`, () => {
      assert.equal(score([{ text: t.text, expect: t.expect! }]).ok, 1);
    });
  }
  for (const call of [...new Set(turns.map((t) => t.call))]) {
    it(`${call} replayed: never says the same line twice in a row`, async () => {
      const orders = sampleOrderSource();
      const said: string[] = [];
      const session = new CallSession({
        telephony: { say: (x) => void said.push(x), ringOwner: async () => "no_answer", connectOwner() {}, hangUp() {} },
        sms: { async send() {} },
        lookup: (o, c) => lookupOrder(orders, o, c),
        lookupByName: (x) => lookupByName(orders, x),
        log: openCallLog(),
        ownerTextTo: "0491570110",
      });
      await session.start("0491570110");
      for (const t of turns.filter((x) => x.call === call)) if (session.phase !== "done") await session.heard(t.text);
      for (let i = 1; i < said.length; i += 1) assert.notEqual(said[i], said[i - 1]);
    });
  }
});

describe("phone line: transcript loop", () => {
  it("finds misheard turns and masks numbers", () => {
    const raw = [
      "+1.0s line: Hi, it's Gannet Street Kitchen. What's your order number?",
      "+5.0s caller: blah [join wait 900 ms]",
      "+5.1s line: Sorry, I missed that. What's the order number?",
      "+9.0s caller: 0 4 1 2 3 4 5 6 7 8",
      "+9.1s line: Thanks.",
    ].join("\n");
    const out = findIssues("x", parseTrace(raw));
    assert.equal(out[0]!.issue, "misheard");
    assert.equal(out[0]!.text, "blah");
    assert.doesNotMatch(out[1]!.text, /12345678/);
  });
  it("keeps sample-order numbers (they're fiction) and masks others", () => {
    assert.equal(maskPhones("0491 570 156"), "0491 570 156");
    assert.doesNotMatch(maskPhones("it's 0412 345 678"), /345/);
  });
});

describe(`phone line: Australian phrase list (${au.length} phrases${process.env.PHRASES_AU_PATH ? ", incl. internal set" : ", repo sample"})`, () => {
  it("every phrase gets the right handling", () => {
    const s = score(au);
    assert.deepEqual(s.misses.map((m) => `${m.text} -> ${m.got}`), []);
  });
});
