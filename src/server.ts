import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
const webhookSecret = process.env.WEBHOOK_SECRET ?? "dev-sample-secret";

const app = createApp({ webhookSecret });

app.listen(port, () => {
  console.log(`Crom Services webhook sample listening on :${port}`);
});
