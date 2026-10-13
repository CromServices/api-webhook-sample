/** Name + last-3 lookup never reveals another order's status. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openCallLog } from "../src/phone/calllog.ts";
import { LINES } from "../src/phone/flow.ts";
import { lookupByName, lookupOrder } from "../src/phone/lookup.ts";
import { STATUS_WORDS, sampleOrderSource, type OrderSource } from "../src/phone/orders.ts";
import { CallSession } from "../src/phone/session.ts";

const orders = sampleOrderSource();
// Two fiction orders sharing a name and last 3 digits.
const dupes: OrderSource = {
  find: (n) => orders.find(n),
  all: () => [
    ...orders.all!(),
    { number: "1050", name: "Ari", item: "Muffin", phone: "0491570156", email: "a2@example.com", status: "delivered" } as never,
  ],
};
const ready = STATUS_WORDS.ready_to_collect.said;

describe("name + last-3 lookup: privacy", () => {
  it("confirmed order: matches only that order", () => {
    assert.equal(lookupByName(orders, "Ari, 1 5 6", "1042").match, true);
  });
  it("confirmed order: another order's name + digits never match", () => {
    const r = lookupByName(orders, "It's Dom, 157", "1042");
    assert.equal(r.match, false);
    assert.notEqual(r.say, ready);
    assert.ok(!("ambiguous" in r));
  });
  it("confirmed order: picks it even when the name + digits fit several orders", () => {
    const r = lookupByName(dupes, "Ari 156", "1050");
    assert.deepEqual(r, { match: true, status: "delivered", say: STATUS_WORDS.delivered.said });
  });
  it("no confirmed order: a single unique match only", () => {
    assert.equal(lookupByName(orders, "Dom 157").match, true);
    assert.equal(lookupByName(orders, "Dom 999").match, false);
  });
  it("no confirmed order: several matches -> ambiguous, no status", () => {
    const r = lookupByName(dupes, "Ari 156");
    assert.equal(r.match, false);
    assert.equal((r as { ambiguous?: true }).ambiguous, true);
  });

  function call(source: OrderSource, said: string[]) {
    return new CallSession({
      telephony: { say: (x) => void said.push(x), ringOwner: async () => "no_answer", connectOwner() {}, hangUp() {} },
      sms: { async send() {} },
      lookup: (o, c) => lookupOrder(source, o, c),
      lookupByName: (x, n) => lookupByName(source, x, n),
      log: openCallLog(),
      ownerTextTo: "0491570110",
    });
  }
  it("in a call: after a no-match on 1042, another order's name + digits reveal nothing", async () => {
    const said: string[] = [];
    const s = call(orders, said);
    await s.start("0491570110");
    await s.heard("one oh four two");
    await s.heard("0491 570 999");
    await s.heard("It's Dom, one five seven");
    assert.ok(!said.includes(ready), said.join(" | "));
    assert.ok(said.includes(LINES.handoffNoMatch));
  });
  it("in a call with no order number: several matches hand over to Sam", async () => {
    const said: string[] = [];
    const s = call(dupes, said);
    await s.start("0491570110");
    await s.heard("I don't have the order number");
    await s.heard("Ari, one five six");
    assert.ok(said.includes(LINES.handoffNoMatch), said.join(" | "));
    assert.ok(!said.some((x) => Object.values(STATUS_WORDS).some((w) => w.said === x)));
    assert.equal(s.phase === "done" || s.phase === "ringing_owner" || s.phase === "take_message", true);
  });
});
