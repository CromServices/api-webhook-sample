/** Scenario re-run 13 Oct (change request): STT lost the "@" in "dom dot p at example dot com". */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initialState, step, type FlowState } from "../../src/phone/flow.ts";
import { lookupOrder } from "../../src/phone/lookup.ts";
import { emailMatchesHeard, normaliseContact } from "../../src/phone/normalise.ts";
import { sampleOrderSource } from "../../src/phone/orders.ts";

const HEARD = ["dom.padexample.com", "dom dot p at example dot com", "dom.p@example.com", "dom.p example.com", "Dom dot pat example dot com.", "It's dom.patexample.com", "dom.p at example.com"];

describe("phone line: spoken email with the @ lost by speech-to-text", () => {
  for (const h of HEARD) {
    it(`order 1045 matches "${h}"`, () => {
      assert.ok(normaliseContact(h), "recognised as a contact");
      assert.equal(lookupOrder(sampleOrderSource(), "1045", h).match, true);
    });
  }
  it("sample order 1045 holds dom.p@example.com", () => {
    assert.equal(sampleOrderSource().find("1045")?.email, "dom.p@example.com");
  });
  it("an @-less address only matches the whole email of THAT order", () => {
    assert.equal(lookupOrder(sampleOrderSource(), "1042", "dom.padexample.com").match, false);
    assert.equal(lookupOrder(sampleOrderSource(), "1045", "dom.padexample.com.au").match, false);
    assert.equal(lookupOrder(sampleOrderSource(), "1045", "domexample.com").match, false);
    assert.equal(lookupOrder(sampleOrderSource(), "1045", "tom.padexample.com").match, false);
    assert.equal(emailMatchesHeard("dom.p@example.com", "dom.pxexample.com"), false);
  });
  it("plain words and numbers are not taken as an email", () => {
    for (const t of ["Can I change it to a long black instead?", "1045", "no that's all thanks", "ten point five"]) {
      const c = normaliseContact(t);
      assert.notEqual(c?.kind, "email", t);
    }
  });
  it("flow: at ask_contact, 'dom.padexample.com' goes to lookup instead of 'Sorry, I missed that'", () => {
    let s: FlowState = step(initialState(), { type: "call_started", caller: "0491570110" }).state;
    for (const text of ["1045", "Yes."]) s = step(s, { type: "heard", text } as any).state;
    assert.equal(s.phase, "ask_contact");
    const r = step(s, { type: "heard", text: "dom.padexample.com" } as any);
    assert.equal(r.state.phase, "looking_up");
    assert.equal((r.actions[0] as any).type, "lookup");
  });
});

/** Live re-run 3 (13 Oct): the line's own STT heard "John dot period example dot com". */
describe("phone line: 'period' for 'p at', and the missing dot", () => {
  const o = () => sampleOrderSource();
  for (const h of ["Dom dot period example dot com", "dom dot period example dot com.", "dom p at example.com", "dom p at example dot com", "domp@example.com", "Dom P at example.com"]) {
    it(`order 1045 matches "${h}"`, () => assert.equal(lookupOrder(o(), "1045", h).match, true));
  }
  it("the exact heard form 'John dot period example dot com' is read as an email but does NOT match (different name)", () => {
    const c = normaliseContact("John dot period example dot com");
    assert.deepEqual(c, { kind: "email", value: "john.p@example.com" });
    assert.equal(lookupOrder(o(), "1045", "John dot period example dot com").match, false);
  });
  it("near misses still fail", () => {
    for (const h of ["dom dot period example dot net", "don p at example.com", "dom pp at example.com", "do m at example.com", "domp@example.com.au", "dom@example.com", "pdom@example.com"])
      assert.equal(lookupOrder(o(), "1045", h).match, false, h);
    assert.equal(lookupOrder(o(), "1042", "dom p at example.com").match, false);
  });
  it("a spoken 'period' that isn't an email isn't taken as one", () => {
    assert.equal(normaliseContact("during the lunch period"), null);
  });
});
