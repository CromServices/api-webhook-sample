#!/usr/bin/env node
// L-054 banned-patterns check. Scans every tracked file; exits 1 on any hit.
// Prints file:line and the rule only (never the matched text), so a leaked secret is not echoed into CI logs.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const skip = (f) => /(^|\/)package-lock\.json$|\.(png|jpe?g|gif|webp|ico|pdf|woff2?|mp3|wav)$/i.test(f) || f === "scripts/ci/banned-patterns.mjs";

// 1. Secrets and tokens: every tracked file.
const SECRETS = [
  ["twilio-account-sid", /\bAC[0-9a-f]{32}\b/],
  ["twilio-api-key-sid", /\bSK[0-9a-f]{32}\b/],
  ["twilio-number-sid", /\bPN[0-9a-f]{32}\b/],
  ["auth-token-literal", /(auth[_-]?token|api[_-]?key|secret|password)["']?\s*[:=]\s*["'][A-Za-z0-9_\-]{24,}["']/i],
  ["xai-key", /\bxai-[A-Za-z0-9]{20,}/],
  ["openai-style-key", /\bsk-(proj-)?[A-Za-z0-9_\-]{20,}/],
  ["github-token", /\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/],
  ["aws-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["fly-token", /\bFlyV1 [A-Za-z0-9_\-+/=]{20,}/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

// 2. Real phone numbers. The owner's mobile in any spacing, then any unmasked AU mobile outside the fictional/test ranges.
const OWNER_MOBILE = /(?!)/; // owner mobile removed from history (16 Oct); see the hashed check on later commits
const AU_MOBILE = /(?<![\d*•x])(?:\+?61[\s\-]?|0)4\d{2}[\s\-]?\d{3}[\s\-]?\d{3}(?!\d)/g;
// Test fixtures: ACMA fictional range 0491 57x xxx, all-zero 0400 000 xxx, 0412 345 678 style sequences.
const allowedMobile = (m) => {
  const d = m.replace(/\D/g, "").replace(/^61/, "0");
  return /^04915[78]\d{4}$/.test(d) || /^0491579\d{3}$/.test(d) || /^0400000\d{3}$/.test(d) || /^04(12345678|00111222|11111111|22222222|98765432|00123456)$/.test(d) || /^04\d0{3,}/.test(d.slice(0,2)+d.slice(3));
};

// 3. Personal emails (cromservices@gmail.com is the firm address, allowed on demo sites by L-032).
const EMAIL = /\b[A-Za-z0-9._%+\-]+@(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|bigpond|optusnet)\.[a-z.]{2,}/gi;
const allowedEmail = (e) => /^cromservices@gmail\.com$/i.test(e);

// Published demo-only values (the sample's documented HMAC demo secret, test fixtures) are not secrets.
const DEMO_VALUE = /["'](crom-demo-[\w-]+|test-secret-not-for-production)["']/;
// Made-up addresses in speech-to-text test fixtures are fine; the owner's own local parts never are.

// 4. Public face: owner's name anywhere in tracked text (L-032).
// Owner name rules. The patterns are never stored here: BANNED_NAME_PATTERNS (env / CI secret only) holds one regex source.
// Unset: the name rules are skipped with a notice locally, and the run fails when CI is set (fail closed).
const NAME_SRC = process.env.BANNED_NAME_PATTERNS ?? "";
let OWNER_NAME = null;
let OWNER_LOCAL = null;
if (NAME_SRC) {
  OWNER_NAME = new RegExp(NAME_SRC);
  OWNER_LOCAL = new RegExp(NAME_SRC, "i");
} else if (process.env.CI) {
  console.error("banned-patterns: BANNED_NAME_PATTERNS is not set (required in CI)");
  process.exit(1);
} else {
  console.error("banned-patterns: owner-name rules skipped (BANNED_NAME_PATTERNS not set)");
}

// 5. Vendor/tool/bot wording, public copy only: docs/, public/, and the string literals in files that build pages or spoken/sent copy.
const COPY_FILES = /^(docs|public)\/.*\.(html?|md|txt|json)$|^src\/(pages|present|story|landing)\.ts$|^src\/(phone|whatsapp)\/(page|flow)\.ts$/;
const VENDOR = /\b(AI|A\.I\.|[Bb]ots?|[Cc]hat ?[Bb]ot|Grok|xAI|Twilio|Meta|OpenAI|ChatGPT|Claude|Anthropic|Cursor|Lovable|Fly\.io|fly\.dev|Supabase|LLM|GPT)\b/;
const literals = (src) => {
  // Keep only text inside quotes/backticks, drop ${...} expressions and HTML tags/attributes.
  const out = [];
  const re = /`((?:\\.|[^`\\])*)`|"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'/g;
  let m;
  while ((m = re.exec(src))) {
    let s = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ").replace(/<[^>]*>/g, " ");
    if (/^(\.{0,2}\/|node:|[a-z@][\w\-./]*$)/.test(s)) continue; // import paths, bare identifiers
    out.push({ s, line: src.slice(0, m.index).split("\n").length });
  }
  return out;
};

// 6. Internal phrase datasets never ship in public folders (and no phrasebank copy anywhere in the repo).
const PHRASE_PUBLIC = /^(docs|public)\/.*(phrase|utterance|intent|call-turns|transcript)/i;
const PHRASEBANK_FILE = /(^|\/)phrase-?bank(\/|[._-])/i;

const hits = [];
const hit = (f, line, rule) => hits.push(`${f}:${line}  ${rule}`);

for (const f of files) {
  if (skip(f)) continue;
  if (PHRASE_PUBLIC.test(f)) hit(f, 0, "phrase-dataset-in-public-folder");
  if (PHRASEBANK_FILE.test(f)) hit(f, 0, "phrasebank-file-in-repo");
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  if (text.includes("\0")) continue;
  text.split("\n").forEach((ln, i) => {
    const n = i + 1;
    if (/banned-patterns: allow/.test(ln)) return;
    for (const [rule, re] of SECRETS) if (re.test(ln) && !DEMO_VALUE.test(ln)) hit(f, n, `secret:${rule}`);
    if (OWNER_MOBILE.test(ln)) hit(f, n, "phone:owner-mobile");
    for (const m of ln.matchAll(AU_MOBILE)) if (!allowedMobile(m[0])) hit(f, n, "phone:unmasked-au-mobile");
    for (const m of ln.matchAll(EMAIL)) if (!allowedEmail(m[0]) && !(f.startsWith("test/") && !OWNER_LOCAL?.test(m[0]))) hit(f, n, "personal-email");
    if (OWNER_NAME?.test(ln)) hit(f, n, "public-face:owner-name");
  });
  if (COPY_FILES.test(f)) {
    const parts = f.endsWith(".ts") ? literals(text) : text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, (b) => b.replace(/[^\n]/g, " ")).replace(/<[^>]*>/g, " ").split("\n").map((s, i) => ({ s, line: i + 1 }));
    for (const { s, line } of parts) { const v = s.match(VENDOR); if (v) hit(f, line, `public-copy:vendor-word(${v[0]})`); }
  }
}

if (hits.length) {
  console.error(`banned-patterns: ${hits.length} hit(s)\n` + [...new Set(hits)].join("\n"));
  process.exit(1);
}
console.log(`banned-patterns: clean (${files.length} tracked files)`);
