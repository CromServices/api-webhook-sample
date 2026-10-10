import path from "node:path";
import { createApp, DEMO_WEBHOOK_SECRET } from "./app.ts";
import { openCallLog } from "./phone/calllog.ts";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const webhookSecret = process.env.WEBHOOK_SECRET ?? DEMO_WEBHOOK_SECRET;
const dataPath = process.env.DATA_PATH ?? path.join(process.cwd(), "data", "demo-shop.json");

const app = createApp({
  webhookSecret,
  dataPath,
  adminToken: process.env.DEMO_ADMIN_TOKEN ?? "",
  webhookUrl: () => `http://127.0.0.1:${port}/webhook`,
  dataSeedPath: process.env.DATA_SEED_PATH || undefined,
  // All unset by default: the phone line routes answer 404 until these are set
  // with `fly secrets set` (never in fly.toml or the repo).
  phoneLine: {
    lookupKey: process.env.PHONE_LINE_KEY ?? "",
    viewUser: process.env.CALL_LOG_USER ?? "",
    viewPassword: process.env.CALL_LOG_PASSWORD ?? "",
    callLog: openCallLog(process.env.CALL_LOG_PATH || undefined),
    timeZone: process.env.SHOP_TIME_ZONE ?? "Australia/Sydney",
  },
});

app.listen(port, host, () => {
  app.resumePending();
  console.log(`Crom Services sample listening on ${host}:${port}`);
});
