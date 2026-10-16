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
  whatsApp:
    process.env.WHATSAPP_ENABLED === "1"
      ? {
          authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
          publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
          viewUser: process.env.WHATSAPP_INBOX_USER ?? "",
          viewPassword: process.env.WHATSAPP_INBOX_PASSWORD ?? "",
          chat: {
            orderUrl: process.env.SHOP_ORDER_URL || undefined,
            replyPromise: process.env.WHATSAPP_REPLY_PROMISE || undefined,
          },
        }
      : undefined,
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
      // Voicemail text by xAI speech-to-text (REST, about US$0.10/hour). Twilio's paid transcription is off.
      transcribeVoicemail:
        process.env.PHONE_VOICEMAIL_TRANSCRIBE === "1" && process.env.XAI_API_KEY
          ? async (wav) => {
              const form = new FormData();
              form.append("model", "grok-voice-transcribe-2.0");
              form.append("language", "en");
              form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "voicemail.wav");
              const r = await fetch("https://api.x.ai/v1/stt", {
                method: "POST",
                headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` },
                body: form,
              });
              if (!r.ok) throw new Error(`stt ${r.status}`);
              return String(((await r.json()) as { text?: string }).text ?? "");
            }
          : undefined,
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
