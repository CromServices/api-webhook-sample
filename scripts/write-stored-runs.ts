import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createApp as createLeadsApp } from "../features/ad-leads/app.ts";
import { runBoth as runLeads } from "../features/ad-leads/scenario.ts";
import { createApp as createOrdersApp } from "../features/order-sync/app.ts";
import { runBoth as runOrders } from "../features/order-sync/scenario.ts";

async function listen(app: { listen: Server["listen"] }): Promise<{ server: Server; base: string }> {
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return { server, base: `http://127.0.0.1:${addr.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function writeLeads(): Promise<void> {
  const dataPath = path.join(mkdtempSync(path.join(tmpdir(), "crom-leads-seed-")), "leads.json");
  const token = "fixture-admin";
  let base = "";
  const app = createLeadsApp({
    webhookSecret: "fixture-webhook",
    appSecret: "fixture-app-secret",
    verifyToken: "fixture-verify",
    adminToken: token,
    dataPath,
    exportDelayMs: 80,
    retryDelayMs: 20,
    clientTimeoutMs: 2000,
    leadgenUrl: () => `${base}/leadgen`,
  });
  const started = await listen(app);
  base = started.base;
  try {
    await runLeads(base, token);
  } finally {
    await close(started.server);
  }
  const { copyFileSync } = await import("node:fs");
  const dest = path.join(process.cwd(), "features/ad-leads/fixtures/stored-run.json");
  copyFileSync(dataPath, dest);
  console.log(`wrote ${dest}`);
}

async function writeOrders(): Promise<void> {
  const dataPath = path.join(mkdtempSync(path.join(tmpdir(), "crom-shop-seed-")), "demo-shop.json");
  const token = "fixture-admin";
  let base = "";
  const app = createOrdersApp({
    webhookSecret: "fixture-webhook",
    adminToken: token,
    dataPath,
    webhookUrl: () => `${base}/webhook`,
    clientTimeoutMs: 80,
    retryDelaysMs: [30, 60],
  });
  const started = await listen(app);
  base = started.base;
  try {
    await runOrders(base, token, dataPath);
  } finally {
    await close(started.server);
  }
  const { copyFileSync } = await import("node:fs");
  const dest = path.join(process.cwd(), "features/order-sync/fixtures/stored-run.json");
  copyFileSync(dataPath, dest);
  console.log(`wrote ${dest}`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  Promise.all([writeLeads(), writeOrders()]).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
