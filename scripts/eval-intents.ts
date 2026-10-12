/**
 * Intent accuracy over phrase sets. Repo fixtures (own phrases, masked call turns) always;
 * the public-dataset corpus only if PHRASEBANK_DIR points at it (kept out of this repo).
 *   PHRASEBANK_DIR=../phrasebank npx tsx scripts/eval-intents.ts [--bank] [--misses]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { detectIntent } from "../src/phone/flow.ts";
import { normaliseContact, readOrderNumber } from "../src/phone/normalise.ts";

export type Row = { text: string; expect: string; src?: string; label?: string };

/** Our intent -> the handling class the corpora are labelled with. */
export function handling(text: string): string {
  const i = detectIntent(text);
  if (i === "change" || i === "complaint") return "handoff";
  if (i === "message") return "person";
  return i;
}

export function score(rows: Row[]) {
  const per: Record<string, { n: number; ok: number }> = {};
  const misses: Array<Row & { got: string }> = [];
  for (const r of rows) {
    const got =
      r.expect === "number"
        ? readOrderNumber(r.text) ? "number" : "none"
        : r.expect === "contact"
          ? normaliseContact(r.text) ? "contact" : "none"
          : handling(r.text);
    const p = (per[r.expect] ??= { n: 0, ok: 0 });
    p.n += 1;
    if (got === r.expect) p.ok += 1;
    else misses.push({ ...r, got });
  }
  const n = rows.length;
  const ok = Object.values(per).reduce((a, b) => a + b.ok, 0);
  return { n, ok, acc: n ? ok / n : 0, per, misses };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sets: Array<[string, Row[]]> = [];
  const here = path.dirname(new URL(import.meta.url).pathname);
  sets.push(["own AU phrases", JSON.parse(readFileSync(path.join(here, "../test/fixtures/phrases-au.json"), "utf8"))]);
  const calls = path.join(here, "../test/fixtures/call-turns.json");
  if (existsSync(calls)) sets.push(["real call turns", JSON.parse(readFileSync(calls, "utf8")).filter((r: Row) => r.expect)]);
  const dir = process.env.PHRASEBANK_DIR;
  if (dir) {
    const file = process.argv.includes("--bank") ? "bank.json" : "corpus.json";
    sets.push([`public corpus (${file})`, JSON.parse(readFileSync(path.join(dir, file), "utf8"))]);
  }
  for (const [name, rows] of sets) {
    const s = score(rows);
    console.log(`\n${name}: ${s.ok}/${s.n} = ${(s.acc * 100).toFixed(1)}%`);
    for (const [k, v] of Object.entries(s.per)) console.log(`  ${k.padEnd(10)} ${v.ok}/${v.n} (${((v.ok / v.n) * 100).toFixed(0)}%)`);
    if (process.argv.includes("--misses")) for (const m of s.misses.slice(0, 25)) console.log(`   x [${m.expect}->${m.got}] ${m.text}`);
  }
}
