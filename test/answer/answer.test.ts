import { test } from "node:test";
import assert from "node:assert/strict";
import { actionOf, said, startLine, wait } from "./harness.ts";
import { readReference, sayReference } from "../../src/answer/reference.ts";
import { ASKED_ABOUT_AI, W } from "../../src/answer/words.ts";
import { summaryEmail } from "../../src/answer/mail.ts";

const CALL = (sid: string, extra: Record<string, string> = {}) => ({ CallSid: sid, From: "+61491570156", To: "+61800000000", ...extra });
const BANNED = /\b(bot|robot|ai|artificial|automated|virtual|assistant|machine|grok|twilio|resend|xai)\b/i;

test("reference reader: digits, spoken digits, quantities, mixed, NATO, keyed, none", () => {
  assert.deepEqual(readReference("it's 1042"), { value: "1042", sure: true });
  assert.deepEqual(readReference("one oh four two"), { value: "1042", sure: true });
  assert.equal(readReference("a thousand and forty two")?.value, "1042");
  assert.equal(readReference("J K 4 4 1 9")?.value, "JK4419");
  assert.equal(readReference("juliet kilo four four one nine")?.value, "JK4419");
  assert.equal(readReference("my order is AB12 345")?.value, "AB12345");
  assert.equal(readReference("", "88231")?.value, "88231");
  assert.equal(readReference("one o four two")?.value, "1042");
  assert.equal(readReference("I don't have a reference")?.value, "none");
  assert.equal(readReference("no reference")?.value, "none");
  assert.equal(readReference("um I'm not sure what you mean"), null);
  assert.equal(sayReference("1042"), "one, oh, four, two");
  assert.equal(sayReference("JK40"), "J, K, four, zero");
});

test("scripted call 1: happy path (keypad menu, spoken details, read-back yes, recorded issue) -> one tidy email with transcript + recording", async () => {
  const l = await startLine();
  try {
    let r = await l.post("/answer/voice", CALL("CA1"));
    assert.equal(r.status, 200);
    assert.match(said(r.text).join(" "), /Thanks for calling Crom Services/);
    assert.equal(actionOf(r.text), "/answer/menu");
    r = await l.post("/answer/menu", CALL("CA1", { Digits: "1" }));
    assert.deepEqual(said(r.text), [W.name]);
    r = await l.post("/answer/name", CALL("CA1", { SpeechResult: "My name is Jane Citizen." }));
    assert.deepEqual(said(r.text), [W.contact]);
    r = await l.post("/answer/contact", CALL("CA1", { SpeechResult: "jane dot citizen at example dot com" }));
    assert.match(said(r.text)[0]!, /jane dot citizen at example dot com/);
    r = await l.post("/answer/ref", CALL("CA1", { SpeechResult: "It's order one oh four two." }));
    assert.equal(said(r.text)[0], W.refConfirm("one, oh, four, two"));
    assert.equal(actionOf(r.text), "/answer/confirm");
    r = await l.post("/answer/confirm", CALL("CA1", { SpeechResult: "Yes, that's right." }));
    assert.equal(said(r.text)[0], W.issue);
    assert.match(r.text, /<Record /);
    r = await l.post("/answer/recorded", CALL("CA1", { RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC_test/Recordings/RE1", RecordingDuration: "9" }));
    assert.equal(said(r.text)[0], W.done);
    assert.match(W.done, /reply in writing within 1 business day/);
    assert.match(r.text, /<Hangup\/>/);
    r = await l.post("/answer/recording", CALL("CA1", { RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC_test/Recordings/RE1", RecordingDuration: "9", RecordingStatus: "completed" }));
    assert.equal(r.status, 204);
    await wait(50);
    await l.post("/answer/status", CALL("CA1", { CallStatus: "completed" }));
    await wait(60);
    assert.equal(l.sent.length, 1, "exactly one email");
    const m = l.sent[0];
    assert.match(m.subject, /Support message: Jane Citizen, ref 1042/);
    assert.match(m.text, /Reply to: jane\.citizen@example\.com/);
    assert.match(m.text, /1042 \(read back and confirmed by the caller\)/);
    assert.match(m.text, /parcel arrived damaged/);
    assert.equal(m.replyTo, "jane.citizen@example.com");
    assert.equal(m.attachments[0].filename, "support-message.mp3");
  } finally {
    l.close();
  }
});

test("scripted call 2: spoken menu, phone contact, wrong read-back then keyed reference", async () => {
  const l = await startLine();
  try {
    await l.post("/answer/voice", CALL("CA2"));
    let r = await l.post("/answer/menu", CALL("CA2", { SpeechResult: "support please" }));
    assert.deepEqual(said(r.text), [W.name]);
    await l.post("/answer/name", CALL("CA2", { SpeechResult: "Sam Example" }));
    r = await l.post("/answer/contact", CALL("CA2", { SpeechResult: "oh four nine one five seven oh one five six" }));
    assert.match(said(r.text)[0]!, /oh four nine one five seven oh one five six/);
    r = await l.post("/answer/ref", CALL("CA2", { SpeechResult: "ten forty two" }));
    r = await l.post("/answer/confirm", CALL("CA2", { Digits: "2" }));
    assert.equal(said(r.text)[0], W.refAgain);
    r = await l.post("/answer/ref", CALL("CA2", { Digits: "1042" }));
    assert.equal(said(r.text)[0], W.refConfirm("one, oh, four, two"));
    r = await l.post("/answer/confirm", CALL("CA2", { Digits: "1" }));
    r = await l.post("/answer/recorded", CALL("CA2", { RecordingDuration: "0" }));
    assert.equal(said(r.text)[0], W.noIssue);
    await wait(30);
    assert.equal(l.sent.length, 1);
    assert.match(l.sent[0].text, /Reply to: 0491570156/);
    assert.match(l.sent[0].text, /Reference tries: ten forty two \| keyed 1042/);
  } finally {
    l.close();
  }
});

test("scripted call 3: option 2 goes to the Sam's Café sample line", async () => {
  const l = await startLine();
  try {
    await l.post("/answer/voice", CALL("CA3"));
    const r = await l.post("/answer/menu", CALL("CA3", { Digits: "2" }));
    assert.equal(actionOf(r.text), "/phone/voice");
    const s = await l.post("/answer/menu", CALL("CA3b", { SpeechResult: "Sam's cafe" }));
    assert.equal(actionOf(s.text), "/phone/voice");
    await l.post("/answer/status", CALL("CA3", { CallStatus: "completed" }));
    await wait(40);
    assert.equal(l.sent.length, 0, "no support email for café calls");
  } finally {
    l.close();
  }
});

test("scripted call 4: caller asks if it's a bot -> L-064 answer, then the same question", async () => {
  const l = await startLine();
  try {
    await l.post("/answer/voice", CALL("CA4"));
    let r = await l.post("/answer/menu", CALL("CA4", { SpeechResult: "Am I talking to a robot?" }));
    assert.equal(said(r.text)[0], ASKED_ABOUT_AI);
    assert.equal(actionOf(r.text), "/answer/menu");
    await l.post("/answer/menu", CALL("CA4", { Digits: "1" }));
    r = await l.post("/answer/name", CALL("CA4", { SpeechResult: "Is this a real person?" }));
    assert.equal(said(r.text)[0], ASKED_ABOUT_AI);
    assert.equal(actionOf(r.text), "/answer/name");
  } finally {
    l.close();
  }
});

test("scripted call 5: hang-up after the reference -> partial email still goes", async () => {
  const l = await startLine();
  try {
    await l.post("/answer/voice", CALL("CA5"));
    await l.post("/answer/menu", CALL("CA5", { Digits: "1" }));
    await l.post("/answer/name", CALL("CA5", { SpeechResult: "Lee" }));
    await l.post("/answer/contact", CALL("CA5", { SpeechResult: "lee at example dot com" }));
    await l.post("/answer/ref", CALL("CA5", { SpeechResult: "no reference" }));
    await l.post("/answer/status", CALL("CA5", { CallStatus: "completed" }));
    await wait(80);
    assert.equal(l.sent.length, 1);
    assert.match(l.sent[0].subject, /\(partial\)/);
    assert.match(l.sent[0].text, /none \(caller has no reference\)/);
  } finally {
    l.close();
  }
});

test("test call 1 fix: 'dart' heard for 'dot' in an email; name in title case", async () => {
  const l = await startLine();
  try {
    await l.post("/answer/voice", CALL("CA6"));
    await l.post("/answer/menu", CALL("CA6", { Digits: "1" }));
    await l.post("/answer/name", CALL("CA6", { SpeechResult: "Jane citizen" }));
    const r = await l.post("/answer/contact", CALL("CA6", { SpeechResult: "Jane dart citizen at example.com" }));
    assert.match(said(r.text)[0]!, /jane dot citizen at example dot com/);
    assert.equal(l.line.calls.get("CA6")?.name, "Jane Citizen");
  } finally {
    l.close();
  }
});

test("unsigned or wrongly signed webhooks get 403", async () => {
  const l = await startLine();
  try {
    for (const p of ["/answer/voice", "/answer/menu", "/answer/recording", "/answer/status"]) {
      assert.equal((await l.post(p, CALL("CAX"), false)).status, 403);
    }
  } finally {
    l.close();
  }
});

test("nothing the caller hears unprompted uses bot, AI or vendor wording; reply promise is in writing, 1 business day", () => {
  const lines = Object.values(W).map((v) => (typeof v === "function" ? (v as (s: string) => string)("one, two") : v));
  for (const line of lines) assert.doesNotMatch(line, BANNED, line);
  assert.match(W.done, /in writing within 1 business day/);
});

test("phone L-064 answer is word for word, and 'assistant' or the owner's name is nowhere a caller can hear", () => {
  assert.equal(ASKED_ABOUT_AI, "This line takes your details 24/7 so nothing gets missed, even after hours. The Crom team reviews every message and replies in writing.");
  const lines = [ASKED_ABOUT_AI, ...Object.values(W).map((v) => (typeof v === "function" ? (v as (s: string) => string)("one, two") : v))];
  for (const line of lines) assert.doesNotMatch(line, /assistant|\bNate\b|Nathan/i, line); // banned-patterns: allow (test pattern for the owner name)
});

test("summary email has no vendor wording and keeps the caller's details only in the private email", () => {
  const m = summaryEmail(
    { ref: "CA9", startedAt: "2026-10-16T08:00:00Z", callerId: "", name: "Jo", contactHeard: "x", contact: null, reference: "", referenceConfirmed: false, referenceHeard: [], issueText: "", recordingSeconds: null, partial: false },
    "Australia/Perth",
  );
  assert.match(m.text, /16 Oct 2026, 4:00 pm AWST/);
  assert.doesNotMatch(m.text + m.html, /\b(twilio|resend|xai|grok|bot)\b/i);
});
