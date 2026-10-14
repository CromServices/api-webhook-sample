import { randomBytes } from "node:crypto";
import path from "node:path";
import { DEMO_WEBHOOK_SECRET } from "../features/ad-leads/app.ts";
import { createServerApp } from "./compose.ts";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const webhookSecret = process.env.WEBHOOK_SECRET ?? DEMO_WEBHOOK_SECRET;
const leadsDataPath = process.env.DATA_PATH ?? path.join(process.cwd(), "data", "leads.json");
const ordersDataPath =
  process.env.ORDER_DATA_PATH ?? path.join(process.cwd(), "data", "demo-shop.json");

const app = createServerApp({
  webhookSecret,
  appSecret: process.env.META_APP_SECRET ?? randomBytes(32).toString("hex"),
  verifyToken: process.env.META_VERIFY_TOKEN ?? randomBytes(24).toString("hex"),
  leadsDataPath,
  ordersDataPath,
  adminToken: process.env.DEMO_ADMIN_TOKEN ?? "",
  port,
  seedIfEmpty: true,
});

app.listen(port, host, () => {
  app.resumePending();
  console.log(`Crom Services sample listening on ${host}:${port}`);
});
