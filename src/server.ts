import { createApp, DEMO_WEBHOOK_SECRET } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const webhookSecret = process.env.WEBHOOK_SECRET ?? DEMO_WEBHOOK_SECRET;

const app = createApp({ webhookSecret });

app.listen(port, host, () => {
  console.log(`Crom Services webhook sample listening on ${host}:${port}`);
});
