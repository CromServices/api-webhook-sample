import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

function readList(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function loadPatterns(file) {
  const patterns = [];
  for (const line of readList(file)) {
    const split = line.indexOf(":");
    if (line === "email") {
      patterns.push({ kind: "email", label: "email address" });
      continue;
    }
    if (split === -1) {
      throw new Error(`Bad pattern line: ${line}`);
    }
    const kind = line.slice(0, split);
    const value = line.slice(split + 1);
    if (!value) throw new Error(`Empty pattern: ${line}`);
    patterns.push({ kind, value, label: line });
  }
  return patterns;
}

function loadAllow(file) {
  const markup = [];
  for (const line of readList(file)) {
    if (line.startsWith("markup:")) markup.push(line.slice("markup:".length));
  }
  return { markup };
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function isPublic(rel) {
  if (rel.startsWith("docs/") && rel.endsWith(".html")) return true;
  if (rel === "shared/landing.ts") return true;
  if (/^features\/[^/]+\/pages\.ts$/.test(rel)) return true;
  if (/^features\/[^/]+\/story\.ts$/.test(rel)) return true;
  if (/^features\/[^/]+\/fixtures\/.+\.(html|txt|md)$/.test(rel)) return true;
  return false;
}

function blankComments(text) {
  const keepLines = (block) => block.replace(/[^\n]/g, " ");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, keepLines)
    .replace(/<!--[\s\S]*?-->/g, keepLines)
    .replace(/^[ \t]*\/\/.*$/gm, (line) => " ".repeat(line.length));
}

function stripTags(text) {
  return text.replace(/<[^>]*>/g, " ");
}

function stripPaths(text) {
  return text.replace(/(?:https?:\/\/|\/)[^\s"'<>)]*/g, " ");
}

function wordPattern(value, flags) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, flags);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const RETINA_FILE = /@\d+x\.(?:png|jpe?g|gif|webp|svg)$/i;

function emailHits(text) {
  const hits = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    for (const match of lines[i].matchAll(EMAIL)) {
      if (RETINA_FILE.test(match[0])) continue;
      hits.push(i + 1);
      break;
    }
  }
  return hits;
}

function lineHits(text, regex) {
  const hits = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    regex.lastIndex = 0;
    if (regex.test(lines[i])) hits.push(i + 1);
  }
  return hits;
}

function scanFile(rel, raw, patterns) {
  const findings = [];
  const htmlFile = rel.endsWith(".html") || rel.endsWith("pages.ts") || rel.endsWith("landing.ts");
  const visible = stripPaths(stripTags(raw));
  for (const pattern of patterns) {
    if (pattern.kind === "word" || pattern.kind === "word-i") {
      const flags = pattern.kind === "word-i" ? "i" : "";
      for (const line of lineHits(visible, wordPattern(pattern.value, flags))) {
        findings.push({ line, label: pattern.label });
      }
    } else if (pattern.kind === "email") {
      for (const line of emailHits(raw)) findings.push({ line, label: pattern.label });
      for (const line of emailHits(visible)) findings.push({ line, label: pattern.label });
    } else if (pattern.kind === "literal") {
      const escaped = pattern.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const line of lineHits(raw, new RegExp(escaped, "g"))) {
        findings.push({ line, label: pattern.label });
      }
    } else if (pattern.kind === "github") {
      if (!htmlFile) continue;
      const escaped = pattern.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const line of lineHits(raw, new RegExp(escaped, "gi"))) {
        findings.push({ line, label: pattern.label });
      }
    } else {
      throw new Error(`Unknown pattern kind in ${pattern.label}`);
    }
  }
  const seen = new Set();
  return findings.filter((hit) => {
    const key = `${hit.line}:${hit.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const patterns = loadPatterns(path.join(root, "scripts/banned-patterns.txt"));
const allow = loadAllow(path.join(root, "scripts/banned-allow.txt"));
const files = walk(root, []).map((full) => path.relative(root, full)).filter(isPublic).sort();

let failed = 0;
for (const rel of files) {
  let raw = readFileSync(path.join(root, rel), "utf8");
  raw = raw
    .split("\n")
    .map((line) => (allow.markup.some((snippet) => line.includes(snippet)) ? "" : line))
    .join("\n");
  raw = blankComments(raw);
  const hits = scanFile(rel, raw, patterns);
  for (const hit of hits) {
    failed += 1;
    console.error(`${rel}:${hit.line}: banned ${hit.label}`);
  }
}

if (failed > 0) {
  console.error(`banned check failed: ${failed} hit${failed === 1 ? "" : "s"} in customer-facing files`);
  process.exit(1);
}

console.log(`banned check passed (${files.length} customer-facing files)`);
