import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/app.ts";
import { openCallLog } from "../src/phone/calllog.ts";
import { ACTION_TYPES, ASKED, LINES, TOLD, detectIntent, initialState, step } from "../src/phone/flow.ts";
import { NO_MATCH_SAY, createRateLimiter, lookupOrder } from "../src/phone/lookup.ts";
import {
  normaliseAuPhone,
  normaliseContact,
  normaliseEmail,
  normaliseOrderNumber,
  spokenDigits,
} from "../src/phone/normalise.ts";
import { SAMPLE_ORDERS, sampleOrderSource } from "../src/phone/orders.ts";
import { callLogPage, showPhone } from "../src/phone/page.ts";
import { SCRIPTS, TEST_OWNER_TEXT_TO, runScript } from "./phone-scripts.ts";

const KEY = "test-phone-line-key";
const USER = "sam";
const PASS = "test-view-password";
const orders = sampleOrderSource();

function script(name: string) {
  const found = SCRIPTS.find((s) => s.name === name);
  if (!found) throw new Error(name);
  return found;
}

describe("phone line: normalising what callers say", () => {
  it("reads Australian phone numbers in every common shape", () => {
    for (const input of [
      "0491570006",
      "0491 570 006",
      "0491-570-006",
      "+61 491 570 006",
      "+61491570006",
      "61 491 570 006",
      "0061 491 570 006",
      "+61 (0) 491 570 006",
      "(04) 9157 0006",
      "oh four nine one, five seven oh, oh oh six",
      "zero four nine one five seven zero double oh six",
    ]) {
      assert.equal(normaliseAuPhone(input), "0491570006", input);
    }
    assert.equal(normaliseAuPhone("(08) 5550 1234"), "0855501234");
    assert.equal(normaliseAuPhone("+61 8 5550 1234"), "0855501234");
  });

  it("refuses things that aren't Australian numbers", () => {
    for (const input of ["", "12345", "0491 570", "+1 415 555 0100", "0591570006", "hello", "04915700061"]) {
      assert.equal(normaliseAuPhone(input), null, input);
    }
  });

  it("compares emails without case or spaces, and accepts spoken at/dot", () => {
    assert.equal(normaliseEmail("  Ari.K@Example.COM "), "ari.k@example.com");
    assert.equal(normaliseEmail("ari.k at example dot com"), "ari.k@example.com");
    assert.equal(normaliseEmail("not an email"), null);
    assert.deepEqual(normaliseContact("ARI.K@example.com"), { kind: "email", value: "ari.k@example.com" });
    assert.deepEqual(normaliseContact("+61 491 570 156"), { kind: "phone", value: "0491570156" });
    assert.equal(normaliseContact("talk to Sam"), null);
  });

  it("reads order numbers said in different ways", () => {
    assert.equal(normaliseOrderNumber("1042"), "1042");
    assert.equal(normaliseOrderNumber("#1042"), "1042");
    assert.equal(normaliseOrderNumber("Order number 1042"), "1042");
    assert.equal(normaliseOrderNumber("one oh four two"), "1042");
    assert.equal(normaliseOrderNumber("It's order 1042"), "1042");
    assert.equal(normaliseOrderNumber("I don't know"), null);
    assert.equal(spokenDigits("double five triple oh"), "55000");
  });
});

describe("phone line: read-only order lookup", () => {
  it("gives the status when the phone number matches", () => {
    const result = lookupOrder(orders, "1042", "+61 491 570 156");
    assert.deepEqual(result, { match: true, status: "on_its_way", say: "Your order is on its way to you." });
  });

  it("gives the status when the email matches, whatever the case", () => {
    const result = lookupOrder(orders, "#1042", "ari.k@EXAMPLE.com");
    assert.equal(result.match, true);
  });

  it("says the same thing for a wrong order number and for a wrong contact", () => {
    const wrongOrder = lookupOrder(orders, "1099", "0491 570 156");
    const wrongContact = lookupOrder(orders, "1042", "0491 570 006");
    const wrongEmail = lookupOrder(orders, "1042", "jess.t@example.com");
    const junk = lookupOrder(orders, "abc", "xyz");
    const notStrings = lookupOrder(orders, 1042, { phone: "0491570156" });
    for (const result of [wrongOrder, wrongContact, wrongEmail, junk, notStrings]) {
      assert.deepEqual(result, { match: false, say: NO_MATCH_SAY });
    }
  });

  it("never gives back anything but match, status and the words to say", () => {
    for (const row of SAMPLE_ORDERS) {
      const result = lookupOrder(orders, row.number, row.phone);
      assert.deepEqual(Object.keys(result).sort(), ["match", "say", "status"]);
      const text = JSON.stringify(result);
      for (const secret of [row.item, row.phone, row.email, row.number]) {
        assert.equal(text.includes(secret), false, `${secret} leaked`);
      }
    }
  });

  it("counts a rate limit in a fixed window", () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
    assert.equal(limiter.take("a"), true);
    assert.equal(limiter.take("a"), true);
    assert.equal(limiter.take("a"), false);
    assert.equal(limiter.blocked("a"), true);
    assert.equal(limiter.take("b"), true);
    t = 1000;
    assert.equal(limiter.take("a"), true);
  });
});

describe("phone line: lookup endpoint", () => {
  let server: Server;
  let base = "";
  let dataPath = "";
  let t = 0;

  before(async () => {
    dataPath = path.join(mkdtempSync(path.join(tmpdir(), "crom-phone-")), "demo-shop.json");
    const app = createApp({
      webhookSecret: "test-secret-not-for-production",
      dataPath,
      phoneLine: {
        lookupKey: KEY,
        viewUser: USER,
        viewPassword: PASS,
        perMinute: 12,
        failsPerOrder: 3,
        now: () => t,
      },
    });
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function ask(body: unknown, key: string | null = KEY) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key !== null) headers["x-phone-line-key"] = key;
    return fetch(`${base}/phone/lookup`, { method: "POST", headers, body: JSON.stringify(body) });
  }

  it("needs the shared key", async () => {
    t += 120_000;
    assert.equal((await ask({ orderNumber: "1042", contact: "0491570156" }, null)).status, 401);
    assert.equal((await ask({ orderNumber: "1042", contact: "0491570156" }, "wrong")).status, 401);
  });

  it("answers a match with the status only, and is never cached", async () => {
    t += 120_000;
    const res = await ask({ orderNumber: "1043", contact: "(08) 5550 1234" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), {
      match: true,
      status: "being_made",
      say: "Your order is being made right now.",
    });
    for (const secret of ["Banana bread", "mel.r@example.com", "0855501234", "5550", "1043"]) {
      assert.equal(text.includes(secret), false, `${secret} leaked`);
    }
  });

  it("gives byte-identical answers for wrong order and wrong contact", async () => {
    t += 120_000;
    const wrongOrder = await (await ask({ orderNumber: "1099", contact: "0491570156" })).text();
    const wrongContact = await (await ask({ orderNumber: "1042", contact: "0491570006" })).text();
    const missing = await (await ask({})).text();
    assert.equal(wrongOrder, wrongContact);
    assert.equal(wrongOrder, missing);
    assert.deepEqual(JSON.parse(wrongOrder), { match: false, say: NO_MATCH_SAY });
  });

  it("holds an order number after repeated wrong tries, without saying so", async () => {
    t += 20 * 60_000;
    for (let i = 0; i < 3; i += 1) {
      const body = await (await ask({ orderNumber: "1046", contact: `049157099${i}` })).json();
      assert.equal(body.match, false);
    }
    const right = await (await ask({ orderNumber: "1046", contact: "0491570158" })).json();
    assert.deepEqual(right, { match: false, say: NO_MATCH_SAY });
    t += 16 * 60_000;
    const later = await (await ask({ orderNumber: "1046", contact: "0491570158" })).json();
    assert.equal(later.match, true);
  });

  it("slows down a flood of lookups", async () => {
    t += 20 * 60_000;
    const codes: number[] = [];
    for (let i = 0; i < 14; i += 1) codes.push((await ask({ orderNumber: "1041", contact: "0491570006" })).status);
    assert.deepEqual(codes.slice(0, 12), Array(12).fill(200));
    assert.equal(codes[12], 429);
  });

  it("never touches the shop's saved orders", async () => {
    t += 20 * 60_000;
    const before = readFileSync(dataPath, "utf8");
    await ask({ orderNumber: "1042", contact: "0491570156" });
    await ask({ orderNumber: "1043", contact: "cancel it" });
    assert.equal(readFileSync(dataPath, "utf8"), before);
  });

  it("keeps the call log page behind a sign-in", async () => {
    const none = await fetch(`${base}/calls`);
    assert.equal(none.status, 401);
    assert.match(none.headers.get("www-authenticate") ?? "", /Basic/);
    const wrong = await fetch(`${base}/calls`, {
      headers: { authorization: `Basic ${Buffer.from(`${USER}:nope`).toString("base64")}` },
    });
    assert.equal(wrong.status, 401);
    const ok = await fetch(`${base}/calls`, {
      headers: { authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}` },
    });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /No calls yet/);
  });
});

describe("phone line: closed unless set up", () => {
  it("answers 404 on both routes when no secrets are set (the live demo today)", async () => {
    const app = createApp({ webhookSecret: "x" });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${addr.port}`;
    const lookup = await fetch(`${base}/phone/lookup`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-phone-line-key": "" },
      body: JSON.stringify({ orderNumber: "1042", contact: "0491570156" }),
    });
    assert.equal(lookup.status, 404);
    assert.equal((await fetch(`${base}/calls`)).status, 404);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe("phone line: call flow (scripted calls, mock phone and texts)", () => {
  it("happy path: order number, matching mobile, hears the status, says goodbye", async () => {
    const log = openCallLog();
    const ran = await runScript(script("happy path"), { log });
    assert.equal(ran.said[0], LINES.greet);
    assert.ok(ran.said.includes("Your order is on its way to you."));
    assert.equal(ran.said.at(-1), LINES.bye);
    assert.equal(ran.rang, 0);
    assert.equal(ran.texts.length, 0);
    assert.equal(ran.hungUp, true);
    const [entry] = log.list();
    assert.deepEqual(
      { asked: entry!.asked, told: entry!.told, handedOver: entry!.handedOver },
      { asked: [ASKED.status], told: ["On its way"], handedOver: false },
    );
  });

  it("wrong order number twice: tries again once, then rings Sam, then takes a message", async () => {
    const log = openCallLog();
    const ran = await runScript(script("wrong order number"), { log });
    assert.equal(ran.said.filter((line) => line === LINES.tryAgain).length, 1);
    assert.ok(ran.said.includes(LINES.handoffNoMatch));
    assert.equal(ran.rang, 1);
    assert.equal(ran.texts.length, 1);
    assert.equal(ran.texts[0]!.to, TEST_OWNER_TEXT_TO);
    assert.match(ran.texts[0]!.body, /didn't match/);
    assert.match(ran.texts[0]!.body, /Priya/);
    const [entry] = log.list();
    assert.equal(entry!.handedOver, true);
    assert.equal(entry!.ownerAnswered, false);
    assert.deepEqual(entry!.told, [TOLD.noMatch, TOLD.callBack]);
  });

  it("change request: never changes anything, puts the caller through to Sam", async () => {
    const log = openCallLog();
    const ran = await runScript(script("change request"), { log });
    assert.ok(ran.said.includes("Your order is ready to collect."));
    assert.ok(ran.said.includes(LINES.handoffChange));
    assert.equal(ran.connected, true);
    const [entry] = log.list();
    assert.deepEqual(entry!.asked, [ASKED.status, ASKED.change]);
    assert.deepEqual(entry!.told, ["Ready to collect", TOLD.putThrough]);
    assert.equal(entry!.ownerAnswered, true);
  });

  it("ask for a person: straight through to Sam, no order questions", async () => {
    const log = openCallLog();
    const ran = await runScript(script("ask for a person"), { log });
    assert.deepEqual(ran.said, [LINES.greet, LINES.handoffPerson, LINES.connecting]);
    assert.equal(ran.connected, true);
    assert.deepEqual(log.list()[0]!.asked, [ASKED.person]);
  });

  it("owner doesn't answer: takes a message and texts Sam with it", async () => {
    const log = openCallLog();
    const ran = await runScript(script("owner doesn't answer"), { log });
    assert.ok(ran.said.includes(LINES.noAnswer));
    assert.equal(ran.said.at(-1), LINES.messageTaken);
    assert.equal(ran.connected, false);
    assert.equal(ran.texts.length, 1);
    assert.match(ran.texts[0]!.body, /wants to change an order/);
    assert.match(ran.texts[0]!.body, /\(08\) 5550 1234|0855501234/);
    assert.match(ran.texts[0]!.body, /Please cancel my banana bread/);
    assert.match(ran.texts[0]!.body, /about order 1043|Missed call from/);
    const [entry] = log.list();
    assert.equal(entry!.message, "Hi, it's Mel. Please cancel my banana bread, I can't make it in today. Thanks.");
    assert.equal(entry!.textedOwner, true);
  });

  it("hang-up while waiting to leave a message still texts Sam", async () => {
    const log = openCallLog();
    const ran = await runScript(
      { name: "hang up", caller: "0491571266", owner: "no_answer", seconds: 20, turns: [{ heard: "talk to Sam" }, { hangUp: true }] },
      { log },
    );
    assert.equal(ran.texts.length, 1);
    assert.match(ran.texts[0]!.body, /No message left/);
    assert.equal(log.list()[0]!.textedOwner, true);
  });

  it("two silences end the call politely and still log it", async () => {
    const log = openCallLog();
    const ran = await runScript(
      { name: "quiet", caller: "", owner: "answered", seconds: 15, turns: [{ silence: true }, { silence: true }] },
      { log },
    );
    assert.equal(ran.said.at(-1), LINES.bye);
    assert.equal(log.list().length, 1);
  });

  it("can only ever say, look up, ring, connect, text, hang up and log: no order changes exist", async () => {
    const allowed = new Set(ACTION_TYPES);
    assert.deepEqual([...allowed].sort(), ["connect_owner", "hang_up", "log", "lookup", "ring_owner", "say", "text_owner"]);
    for (const s of SCRIPTS) {
      const ran = await runScript(s);
      for (const action of ran.session.actions) assert.ok(allowed.has(action.type), action.type);
    }
    const frozen = Object.isFrozen(SAMPLE_ORDERS) && SAMPLE_ORDERS.every((row) => Object.isFrozen(row));
    assert.equal(frozen, true);
  });

  it("spots change requests and asks for a person", () => {
    assert.equal(detectIntent("can I cancel my order"), "change");
    assert.equal(detectIntent("I want a refund"), "change");
    assert.equal(detectIntent("could you add a muffin"), "change");
    assert.equal(detectIntent("can I speak to a real person"), "person");
    assert.equal(detectIntent("put me through to Sam"), "person");
    assert.equal(detectIntent("no that's all"), "no");
    assert.equal(detectIntent("yes please"), "yes");
    assert.equal(detectIntent("1042"), "none");
  });

  it("ignores events that don't fit the moment", () => {
    const s = initialState();
    assert.deepEqual(step(s, { type: "owner_answered" }).actions, []);
  });
});

describe("phone line: call log page", () => {
  it("uses plain words only: no order numbers, codes or raw times", async () => {
    const log = openCallLog();
    let start = Date.parse("2026-10-10T01:00:00Z");
    for (const s of SCRIPTS) {
      await runScript(s, { log, startAt: new Date(start) });
      start += 7 * 60_000;
    }
    const html = callLogPage(log.list(), "Australia/Sydney");
    const visible = html
      .replace(/<head>[\s\S]*?<\/head>/, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    for (const banned of [/\b10[0-9]{2}\b/, /\d{4}-\d{2}-\d{2}T/, /[0-9a-f]{8}-[0-9a-f]{4}/i, /\b(AI|bot|agent|automated|webhook|API|lookup|status code)\b/i]) {
      assert.doesNotMatch(visible, banned);
    }
    assert.match(visible, /Caller asked Where's my order/);
    assert.match(visible, /Told On its way/);
    assert.match(visible, /Passed to Sam Yes, Sam picked up/);
    assert.match(visible, /Passed to Sam No/);
    assert.match(visible, /0491 570 156/);
    assert.match(visible, /5 calls\. 4 passed to Sam\./);
    assert.match(visible, /then Sam will call back/);
  });

  it("formats numbers the way people read them", () => {
    assert.equal(showPhone("0491570006"), "0491 570 006");
    assert.equal(showPhone("0855501234"), "(08) 5550 1234");
    assert.equal(showPhone(""), "Number hidden");
  });

  it("keeps calls in a file when given a path", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "crom-calls-")), "calls.json");
    const one = openCallLog(file);
    one.add({
      caller: "0491570006",
      asked: [ASKED.status],
      told: ["Delivered"],
      handedOver: false,
      ownerAnswered: null,
      message: null,
      textedOwner: false,
      startedAt: "2026-10-10T01:00:00.000Z",
      endedAt: "2026-10-10T01:00:30.000Z",
    });
    assert.equal(openCallLog(file).list().length, 1);
  });
});

describe("shop store: optional seed", () => {
  it("starts from the seed when the data file is missing, and leaves an existing file alone", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crom-seed-"));
    const seedPath = path.join(dir, "seed.json");
    const dataPath = path.join(dir, "data", "demo-shop.json");
    const seeded = createApp({ webhookSecret: "x", dataPath });
    void seeded;
    const state = JSON.parse(readFileSync(dataPath, "utf8"));
    state.nextId = 2001;
    writeFileSync(seedPath, JSON.stringify(state));
    const fresh = path.join(dir, "fresh", "demo-shop.json");
    createApp({ webhookSecret: "x", dataPath: fresh, dataSeedPath: seedPath });
    assert.equal(JSON.parse(readFileSync(fresh, "utf8")).nextId, 2001);
    const unset = path.join(dir, "unset", "demo-shop.json");
    createApp({ webhookSecret: "x", dataPath: unset });
    assert.equal(JSON.parse(readFileSync(unset, "utf8")).nextId, 1041);
    assert.equal(existsSync(unset), true);
  });
});
