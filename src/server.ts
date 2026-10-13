import { randomBytes } from "node:crypto";
import path from "node:path";
import { createApp, DEMO_WEBHOOK_SECRET } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const webhookSecret = process.env.WEBHOOK_SECRET ?? DEMO_WEBHOOK_SECRET;
const dataPath = process.env.DATA_PATH ?? path.join(process.cwd(), "data", "leads.json");

const app = createApp({
  webhookSecret,
  appSecret: process.env.META_APP_SECRET ?? randomBytes(32).toString("hex"),
  verifyToken: process.env.META_VERIFY_TOKEN ?? randomBytes(24).toString("hex"),
  dataPath,
  adminToken: process.env.DEMO_ADMIN_TOKEN ?? "",
  leadgenUrl: () => `http://127.0.0.1:${port}/leadgen`,
});

app.listen(port, host, () => {
  console.log(`Crom Services sample listening on ${host}:${port}`);
});
