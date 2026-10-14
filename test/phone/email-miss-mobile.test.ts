/** Director 13 Oct: a spoken email that doesn't match -> ask for the mobile on the order next. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openCallLog } from "../../src/phone/calllog.ts";
import { LINES } from "../../src/phone/flow.ts";
import { lookupByName, lookupOrder } from "../../src/phone/lookup.ts";
import { sampleOrderSource } from "../../src/phone/orders.ts";
import { CallSession } from "../../src/phone/session.ts";

async function call(turns: string[]) {
  const orders = sampleOrderSource();
  const said: string[] = [];
  let rang = 0;
  const s = new CallSession({
    telephony: { say: (x) => void said.push(x), ringOwner: async () => { rang += 1; return "no_answer"; }, connectOwner() {}, hangUp() {} },
    sms: { async send() {} },
    lookup: (o, c) => lookupOrder(orders, o, c),
    lookupByName: (x, n) => lookupByName(orders, x, n),
    log: openCallLog(),
    ownerTextTo: "0491570110",
  });
  await s.start("0491570110");
  for (const t of turns) if (s.phase !== "done") await s.heard(t);
  return { said, rang, s };
}
const ASK_MOBILE = LINES.noMatchEmailAskMobile("1045");

describe("phone line: email miss -> ask for the mobile", () => {
  it("'John dot period example dot com' (live re-run 3) leads to the mobile ask", async () => {
    const { said } = await call(["Ten forty-five", "Yes.", "John dot period example dot com"]);
    assert.equal(said.at(-1), ASK_MOBILE);
    assert.match(ASK_MOBILE, /mobile number on the order/);
    assert.match(ASK_MOBILE, /first name and the last three digits/);
  });
  it("then the correct mobile matches and the status is read", async () => {
    const { said } = await call(["Ten forty-five", "Yes.", "John dot period example dot com", "Oh four nine one, five seven oh, one five seven."]);
    assert.ok(said.includes(ASK_MOBILE));
    assert.equal(said.at(-1), LINES.anythingElse);
    assert.ok(!said.some((x) => /put you through/.test(x)));
  });
  it("a wrong mobile after it hands over (re-ask cap kept, nothing revealed)", async () => {
    const { said } = await call(["Ten forty-five", "Yes.", "John dot period example dot com", "Oh four nine one, five seven oh, one five six."]);
    assert.equal(said.filter((x) => x === ASK_MOBILE).length, 1);
    assert.ok(said.some((x) => x === LINES.handoffNoMatch));
    assert.ok(!said.some((x) => /ready|on its way/i.test(x)));
  });
  it("the name + last 3 option still works after the mobile ask", async () => {
    const { said } = await call(["Ten forty-five", "Yes.", "John dot period example dot com", "It's Dom, one five seven."]);
    assert.equal(said.at(-1), LINES.anythingElse);
  });
  it("a phone no-match keeps the original hint (mobile or email)", async () => {
    const { said } = await call(["Ten forty-five", "Yes.", "Oh four nine one, five seven oh, one five six."]);
    assert.equal(said.at(-1), LINES.noMatchHint("1045"));
  });
});
