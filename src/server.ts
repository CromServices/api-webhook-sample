import path from "node:path";
import { createApp, DEMO_WEBHOOK_SECRET } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const webhookSecret = process.env.WEBHOOK_SECRET ?? DEMO_WEBHOOK_SECRET;
const dataPath = process.env.DATA_PATH ?? path.join(process.cwd(), "data", "demo-shop.json");

const app = createApp({
  webhookSecret,
  dataPath,
  adminToken: process.env.DEMO_ADMIN_TOKEN ?? "",
  webhookUrl: () => `http://127.0.0.1:${port}/webhook`,
});

app.listen(port, host, () => {
  app.resumePending();
  console.log(`Crom Services sample listening on ${host}:${port}`);
});
