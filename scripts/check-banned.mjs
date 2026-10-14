import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

/** Customer routes the running app must serve. Bodies are scanned as sent. */
const RENDERED_ROUTES = [
  { path: "/", status: 200 },
  { path: "/health", status: 200 },
  { path: "/sheet", status: 200 },
  { path: "/alerts", status: 200 },
  { path: "/happened", status: 200 },
  { path: "/before-after", status: 200 },
  { path: "/before-after?view=triage", status: 200 },
  { path: "/leadgen", status: 403 },
  { path: "/shop", status: 200 },
  { path: "/stock", status: 200 },
  { path: "/history", status: 200 },
  { path: "/shop-before-after", status: 200 },
  { path: "/shop-before-after?view=triage", status: 200 },
  { path: "/shop-and-stock", status: 200 },
  { path: "/demo", status: 301 },
  { path: "/demo?view=triage", status: 301 },
];

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

function visibleRendered(html) {
  return stripTags(html);
}

function scanRenderedHtml(raw, patterns) {
  const labels = new Set();
  const visible = visibleRendered(raw);
  for (const pattern of patterns) {
    if (pattern.kind === "word" || pattern.kind === "word-i") {
      const flags = pattern.kind === "word-i" ? "i" : "";
      if (lineHits(raw, wordPattern(pattern.value, flags)).length > 0) labels.add(pattern.label);
    } else if (pattern.kind === "email") {
      if (emailHits(visible).length > 0) labels.add(pattern.label);
    } else if (pattern.kind === "literal") {
      const escaped = pattern.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (lineHits(raw, new RegExp(escaped, "g")).length > 0) labels.add(pattern.label);
    } else if (pattern.kind === "github") {
      const escaped = pattern.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (lineHits(raw, new RegExp(escaped, "gi")).length > 0) labels.add(pattern.label);
    } else {
      throw new Error(`Unknown pattern kind in ${pattern.label}`);
    }
  }
  if (visible.toLowerCase().includes("example")) labels.add("example");
  return [...labels];
}

function tagAttr(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i").exec(tag);
  if (!match) return "";
  return match[2] ?? match[3] ?? match[4] ?? "";
}

/** img/source src + srcset, and stylesheet hrefs, resolved against the page. */
function collectAssets(html, pageUrl) {
  const found = [];
  for (const match of html.matchAll(/<(img|source|link)\b[^>]*>/gi)) {
    const tag = match[0];
    const name = match[1].toLowerCase();
    const raws = [];
    if (name === "link") {
      if (!/\bstylesheet\b/i.test(tagAttr(tag, "rel"))) continue;
      const href = tagAttr(tag, "href");
      if (href) raws.push(href);
    } else {
      const src = tagAttr(tag, "src");
      if (src) raws.push(src);
      const srcset = tagAttr(tag, "srcset");
      if (srcset) {
        for (const part of srcset.split(",")) {
          const url = part.trim().split(/\s+/)[0];
          if (url) raws.push(url);
        }
      }
    }
    for (const raw of raws) {
      if (/^(data|blob):/i.test(raw)) continue;
      try {
        found.push(new URL(raw, pageUrl).href);
      } catch {
        found.push(raw);
      }
    }
  }
  return [...new Set(found)];
}

async function fetchAsset(url) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20000) });
    await res.arrayBuffer();
    return { status: res.status };
  } catch (err) {
    return { status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function waitForHealth(base, child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("timed out waiting for /health")), 10000);
    child.once("exit", (code) => finish(new Error(`server exited (${code}) before /health`)));
    const poll = async () => {
      const start = Date.now();
      while (!settled && Date.now() - start < 10000) {
        try {
          const res = await fetch(`${base}/health`);
          if (res.ok) {
            finish();
            return;
          }
        } catch {
          // the process is still starting
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      finish(new Error("timed out waiting for /health"));
    };
    poll().catch((err) => finish(err));
  });
}

async function scanRunningApp(patterns) {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), "crom-banned-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_PATH: path.join(dir, "leads.json"),
      ORDER_DATA_PATH: path.join(dir, "shop.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });
  const base = `http://127.0.0.1:${port}`;
  let hits = 0;
  const assetStatus = new Map();
  let assetFetches = 0;
  try {
    await waitForHealth(base, child);
    for (const route of RENDERED_ROUTES) {
      const pageUrl = `${base}${route.path}`;
      const res = await fetch(pageUrl, { redirect: "manual" });
      const body = await res.text();
      if (res.status !== route.status) {
        hits += 1;
        console.error(`rendered GET ${route.path}: expected ${route.status}, got ${res.status}`);
      }
      for (const label of scanRenderedHtml(body, patterns)) {
        hits += 1;
        console.error(`rendered GET ${route.path}: banned ${label}`);
      }
      for (const asset of collectAssets(body, pageUrl)) {
        if (!assetStatus.has(asset)) {
          assetStatus.set(asset, await fetchAsset(asset));
          assetFetches += 1;
        }
        const result = assetStatus.get(asset);
        if (result.status !== 200) {
          hits += 1;
          const detail = result.error ? `error ${result.error}` : String(result.status);
          console.error(`rendered GET ${route.path}: asset ${detail} ${asset}`);
        }
      }
    }
  } catch (err) {
    hits += 1;
    console.error(`rendered check could not boot the app: ${err instanceof Error ? err.message : err}`);
    if (log.trim()) console.error(log.trim());
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  return { hits, assetFetches };
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

const rendered = await scanRunningApp(patterns);
failed += rendered.hits;

if (failed > 0) {
  console.error(`banned check failed: ${failed} hit${failed === 1 ? "" : "s"}`);
  process.exit(1);
}

console.log(
  `banned check passed (${files.length} files, ${RENDERED_ROUTES.length} rendered routes, ${rendered.assetFetches} assets)`,
);
