import path from "node:path";
import { createApp, DEMO_WEBHOOK_SECRET } from "./app.ts";
import { openCallLog } from "./phone/calllog.ts";
import { XaiVoiceProvider } from "./phone/voice/xai.ts";

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
    // Twilio voice side. Every /phone/* webhook answers 403 until
    // TWILIO_AUTH_TOKEN and PUBLIC_BASE_URL are set.
    // Swap point: replace XaiVoiceProvider with another VoiceProvider.
    twilio: {
      authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
      accountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
      publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
      ownerNumber: process.env.OWNER_NUMBER || undefined,
      transcriptLog: process.env.PHONE_TRANSCRIPT_LOG === "1",
      // Off until tried on a live call.
      bargeIn: process.env.PHONE_BARGE_IN === "1",
      confirmReask: process.env.PHONE_CONFIRM_REASK === "1",
      voicemailTranscribe: process.env.PHONE_VOICEMAIL_TRANSCRIBE === "1",
      joinMs: process.env.PHONE_JOIN_MS ? Number(process.env.PHONE_JOIN_MS) : undefined,
      provider: new XaiVoiceProvider({
        apiKey: process.env.XAI_API_KEY ?? "",
        voice: process.env.XAI_VOICE || undefined,
      }),
    },
  },
});

const server = app.listen(port, host, () => {
  app.resumePending();
  console.log(`Crom Services sample listening on ${host}:${port}`);
});
app.attachPhone(server);
