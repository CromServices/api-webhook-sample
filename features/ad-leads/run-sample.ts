import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.ts";
import { runBoth } from "./scenario.ts";
import type { Attempt, FacebookLead, Snapshot, State } from "./store.ts";

const ARTIFACTS = "/opt/cursor/artifacts";

type Shot = {
  file: string;
  path: string;
  scale: number;
};

const SHOTS: Shot[] = [
  { file: "01-side-by-side.png", path: "/before-after", scale: 1 },
  { file: "02-triage.png", path: "/before-after?view=triage", scale: 1 },
  { file: "02-triage@2x.png", path: "/before-after?view=triage", scale: 2 },
  { file: "03-sheet-after.png", path: "/sheet", scale: 1 },
  { file: "04-owner-alerts.png", path: "/alerts", scale: 1 },
  { file: "05-what-happened.png", path: "/happened", scale: 1 },
];

function leadName(
  picture: { facebookLeads: FacebookLead[]; sheetRows: { leadgenId: string; name: string }[] },
  id: string,
): string {
  return (
    picture.facebookLeads.find((row) => row.leadgenId === id)?.name ??
    picture.sheetRows.find((row) => row.leadgenId === id)?.name ??
    id
  );
}

function attemptLines(picture: Snapshot): string[] {
  return picture.attempts.map((row: Attempt) => {
    const name = row.outcome === "rejected" ? "(no lead written)" : leadName(picture, row.leadgenId);
    return `- ${row.at} | ${name} | ${row.outcome} | http ${row.httpStatus ?? "none"} | waited ${row.waitedMs} ms | took ${row.elapsedMs} ms`;
  });
}

function runSection(title: string, shot: Snapshot | null): string[] {
  if (!shot) return [`## ${title}`, "", "No snapshot was stored.", ""];
  const lines = [
    `## ${title}`,
    "",
    `- mode: ${shot.mode}`,
    `- opened: ${shot.openedAt}`,
    `- saved: ${shot.savedAt}`,
    `- leads in Facebook: ${shot.facebookLeads.length}`,
    `- rows in the sheet: ${shot.sheetRows.length}`,
    `- owner alerts: ${shot.alerts.length}`,
    `- attempts: ${shot.attempts.length}`,
    "",
    "### Leads in Facebook",
    "",
  ];
  for (const lead of shot.facebookLeads) {
    lines.push(
      `- ${lead.name} | phone entered \`${lead.phoneRaw}\` | stored \`${lead.phone}\` | ${lead.email} | ${lead.want} | form ${lead.formName} | enquiry ${lead.createdTime} | notices ${lead.notifyCount} | already there: ${lead.prior ? "yes" : "no"}`,
    );
  }
  lines.push("", "### Sheet rows", "");
  if (shot.sheetRows.length === 0) lines.push("- none");
  for (const row of shot.sheetRows) {
    lines.push(
      `- ${row.addedAt} | ${row.name} | ${row.phone} | ${row.email} | ${row.want} | ${row.formName} | ${row.status} | enquiry ${row.createdTime}`,
    );
  }
  lines.push("", "### Owner alerts", "");
  if (shot.alerts.length === 0) lines.push("- none");
  for (const alert of shot.alerts) {
    lines.push(`- ${alert.at} | ${alert.name} | ${alert.phone} | ${alert.want}`);
  }
  lines.push("", "### Attempts", "");
  lines.push(...(shot.attempts.length === 0 ? ["- none"] : attemptLines(shot)));
  lines.push("", "### Hand copy", "");
  if (!shot.exportBatch) {
    lines.push("- none");
  } else {
    const names = shot.exportBatch.snapshotted
      .map((item) => `${leadName(shot, item.leadgenId)} × ${item.copies}`)
      .join(", ");
    lines.push(
      `- started ${shot.exportBatch.startedAt}`,
      `- finished ${shot.exportBatch.finishedAt}`,
      `- delay ${shot.exportBatch.delayMs} ms`,
      `- rows written ${shot.exportBatch.rowsWritten}`,
      `- snapshot: ${names || "empty"}`,
    );
  }
  lines.push("");
  return lines;
}

function writeNotes(state: State): void {
  const lines = [
    "# Gannet Street Kitchen catering leads",
    "",
    "Figures read from the stored runs after both finished. Times are UTC. The app secret was generated in memory and is not recorded.",
    "",
    `- duplicate window: ${state.duplicateWindowMs} ms`,
    "",
    ...runSection("Before (copied by hand)", state.snapshots.before),
    ...runSection("After (straight into the sheet)", state.snapshots.after),
  ];
  writeFileSync(path.join(ARTIFACTS, "notes.md"), `${lines.join("\n")}\n`);
}

type CdpMessage = {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

type Session = {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  waitForLoad: () => Promise<void>;
  close: () => void;
};

function connect(wsUrl: string): Promise<Session> {
  const ws = new WebSocket(wsUrl);
  let next = 0;
  const pending = new Map<number, (message: CdpMessage) => void>();
  let onLoad: (() => void) | null = null;
  return new Promise((resolve, reject) => {
    ws.addEventListener("error", () => reject(new Error("browser connection failed")));
    ws.addEventListener("open", () => {
      resolve({
        send(method, params) {
          const id = ++next;
          return new Promise((done, fail) => {
            pending.set(id, (message) => {
              if (message.error) fail(new Error(message.error.message ?? "browser call failed"));
              else done(message.result ?? {});
            });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        waitForLoad() {
          return new Promise((done) => {
            const timer = setTimeout(() => {
              onLoad = null;
              done();
            }, 5000);
            onLoad = () => {
              clearTimeout(timer);
              onLoad = null;
              done();
            };
          });
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id && pending.has(message.id)) {
        const done = pending.get(message.id);
        pending.delete(message.id);
        done?.(message);
      }
      if (message.method === "Page.loadEventFired") onLoad?.();
    });
  });
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function capture(base: string): Promise<void> {
  const profile = mkdtempSync(path.join("/tmp", "crom-chrome-"));
  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--remote-debugging-port=9222",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    let version: { webSocketDebuggerUrl?: string } | null = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const res = await fetch("http://127.0.0.1:9222/json/version");
        if (res.ok) {
          version = (await res.json()) as { webSocketDebuggerUrl?: string };
          break;
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!version?.webSocketDebuggerUrl) throw new Error("browser did not start");
    const browser = await connect(version.webSocketDebuggerUrl);
    const created = (await browser.send("Target.createTarget", { url: "about:blank" })) as { targetId?: string };
    const list = (await (await fetch("http://127.0.0.1:9222/json/list")).json()) as {
      id: string;
      type: string;
      webSocketDebuggerUrl: string;
    }[];
    const page = list.find((item) => item.id === created.targetId) ?? list.find((item) => item.type === "page");
    if (!page) throw new Error("no browser page");
    const session = await connect(page.webSocketDebuggerUrl);
    await session.send("Page.enable");
    await session.send("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    for (const shot of SHOTS) {
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: 1920,
        height: 1080,
        deviceScaleFactor: shot.scale,
        mobile: false,
      });
      const loaded = session.waitForLoad();
      await session.send("Page.navigate", { url: `${base}${shot.path}` });
      await loaded;
      await session.send("Runtime.evaluate", {
        expression: "document.fonts ? document.fonts.ready : true",
        awaitPromise: true,
      });
      const height = (await session.send("Runtime.evaluate", {
        expression:
          "JSON.stringify({scroll:document.documentElement.scrollHeight,footer:document.querySelector('footer')?.getBoundingClientRect().bottom||0})",
        returnByValue: true,
      })) as { result?: { value?: string } };
      const shotResult = (await session.send("Page.captureScreenshot", { format: "png" })) as { data?: string };
      if (!shotResult.data) throw new Error(`empty capture for ${shot.file}`);
      const bytes = Buffer.from(shotResult.data, "base64");
      writeFileSync(path.join(ARTIFACTS, shot.file), bytes);
      const size = pngSize(bytes);
      console.log(`${shot.file} ${size.width}x${size.height} layout=${height.result?.value ?? "?"}`);
    }
    session.close();
    browser.close();
  } finally {
    chrome.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // The browser profile can still be busy after the process exits.
    }
  }
}

async function run(): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true });
  const dataPath = path.join(mkdtempSync(path.join("/tmp", "crom-leads-run-")), "leads.json");
  const adminToken = randomBytes(16).toString("hex");
  let base = "";
  const app = createApp({
    webhookSecret: randomBytes(16).toString("hex"),
    appSecret: randomBytes(32).toString("hex"),
    verifyToken: randomBytes(24).toString("hex"),
    adminToken,
    dataPath,
    exportDelayMs: 400,
    retryDelayMs: 30,
    clientTimeoutMs: 2000,
    leadgenUrl: () => `${base}/leadgen`,
  });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    base = `http://127.0.0.1:${addr.port}`;
    await runBoth(base, adminToken);
    const state = JSON.parse(readFileSync(dataPath, "utf8")) as State;
    writeNotes(state);
    await capture(base);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
