/**
 * Transcript loop: read a call's timed transcript (the call-trace lines), find the turns
 * the line misheard, repeated itself on, or got stuck on, and add the caller's real words
 * to test/phone/fixtures/call-turns.json (which test/call-turns.test.ts replays).
 *   npx tsx scripts/phone/transcript-loop.ts <callName> <transcript.txt> [review.md]
 * Caller phone numbers are replaced with an ACMA fiction number before anything is written.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normaliseAuPhone, spokenDigits } from "../../src/phone/normalise.ts";
import { SAMPLE_ORDERS } from "../../src/phone/orders.ts";

export type Turn = { who: "line" | "caller"; t: number; text: string };
export type CallTurn = {
  call: string;
  t: number;
  text: string;
  issue: "misheard" | "repeat" | "stuck" | "ok";
  lineReply: string;
  /** Optional hand label: status | hours | location | person | handoff | no_number | yes | no | none | number | contact */
  expect?: string;
};

const FICTION = "0 4 9 1 5 7 0 1 1 0"; // ACMA fiction range; never a real caller
const SAMPLE_PHONES = new Set(SAMPLE_ORDERS.map((o) => o.phone));

/** Any phone number in the words that isn't one of the sample orders' becomes the fiction number. */
export function maskPhones(text: string): string {
  const whole = normaliseAuPhone(text);
  if (whole && !SAMPLE_PHONES.has(whole)) {
    // Replace the run of digits/digit-words that makes up the number.
    return text.replace(/((?:\b(?:\d+|zero|oh|o|one|two|three|four|five|six|seven|eight|nine|double|triple)\b[\s,-]*){2,})/gi, `${FICTION} `).trim();
  }
  // Part of a phone number (starts 04 / 02 / 03 / 07 / 08): mask too.
  const partial = text.replace(/((?:\b(?:\d+|zero|oh|o|one|two|three|four|five|six|seven|eight|nine|double|triple)\b[\s,-]*){2,})/gi, (m) => {
    const d = spokenDigits(m);
    return /^0[23478]\d{2,}/.test(d) && !SAMPLE_PHONES.has(d) ? "0 4 9 1 " : m;
  });
  if (partial !== text) return partial.trim();
  return text.replace(/\+?\d[\d\s-]{7,}\d/g, (m) => {
    const p = normaliseAuPhone(m);
    return p && SAMPLE_PHONES.has(p) ? m : FICTION;
  });
}

export function parseTrace(raw: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/\+(\d+(?:\.\d+)?)s (line|caller): (.*)$/);
    if (!m || m[3]!.startsWith("(")) continue;
    turns.push({ t: Number(m[1]), who: m[2] as Turn["who"], text: m[3]!.replace(/ \[join wait \d+ ms\]$/, "").trim() });
  }
  return turns;
}

const MISS = /\b(didn't catch|missed that|couldn't match|having trouble hearing|still there)\b/i;

export function findIssues(call: string, turns: Turn[]): CallTurn[] {
  const out: CallTurn[] = [];
  const asked = new Map<string, number>();
  let lastLine = "";
  for (let i = 0; i < turns.length; i += 1) {
    const tu = turns[i]!;
    if (tu.who === "line") {
      const q = (tu.text.match(/[^.?!]*\?/g) ?? []).map((x) => x.trim().toLowerCase());
      for (const x of q) asked.set(x, (asked.get(x) ?? 0) + 1);
      if (tu.text === lastLine) out.push({ call, t: tu.t, text: "", issue: "repeat", lineReply: tu.text });
      lastLine = tu.text;
      continue;
    }
    const reply = turns.slice(i + 1).find((x) => x.who === "line")?.text ?? "";
    const stuck = (reply.match(/[^.?!]*\?/g) ?? []).some((x) => (asked.get(x.trim().toLowerCase()) ?? 0) >= 2);
    const issue: CallTurn["issue"] = MISS.test(reply) ? "misheard" : stuck ? "stuck" : "ok";
    out.push({ call, t: tu.t, text: maskPhones(tu.text), issue, lineReply: reply });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [call, file] = process.argv.slice(2);
  if (!call || !file) throw new Error("usage: transcript-loop.ts <callName> <transcript.txt>");
  const here = path.dirname(new URL(import.meta.url).pathname);
  const fixture = path.join(here, "../../test/phone/fixtures/call-turns.json");
  const existing: CallTurn[] = existsSync(fixture) ? JSON.parse(readFileSync(fixture, "utf8")) : [];
  const fresh = findIssues(call, parseTrace(readFileSync(file, "utf8"))).filter((t) => t.text);
  const kept = existing.filter((t) => t.call !== call);
  // Keep hand labels from a previous run of the same call.
  for (const f of fresh) {
    const old = existing.find((e) => e.call === call && e.text === f.text);
    if (old?.expect) f.expect = old.expect;
  }
  writeFileSync(fixture, JSON.stringify([...kept, ...fresh], null, 1) + "\n");
  const by = (k: string) => fresh.filter((t) => t.issue === k).length;
  console.log(`${call}: ${fresh.length} caller turns (misheard ${by("misheard")}, stuck ${by("stuck")}, ok ${by("ok")}) -> ${path.relative(process.cwd(), fixture)}`);
}
