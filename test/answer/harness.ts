import express from "express";
import type { AddressInfo } from "node:net";
import { twilioSignature } from "../../src/phone/twilio.ts";
import { mountAnswerLine } from "../../src/answer/routes.ts";

export const TOKEN = "test-secret-not-for-production";
export const BASE = "https://line.example.test";

/** Scripted caller: posts Twilio-signed form bodies to the line, like Twilio would. */
export async function startLine(extra: { mailFail?: boolean } = {}) {
  const sent: any[] = [];
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  // Sam's Café sample stand-in, to prove option 2 lands on /phone/voice.
  app.post("/phone/voice", (_req, res) => res.type("text/xml").send("<Response><Say>cafe</Say></Response>"));
  const line = mountAnswerLine(app, {
    authToken: TOKEN,
    accountSid: "AC_test",
    publicBaseUrl: BASE,
    partialDelayMs: 20,
    transcribe: async () => "My parcel arrived damaged and I would like a replacement.",
    fetchImpl: (async (url: string) => new Response(Buffer.from(String(url).endsWith(".mp3") ? "ID3fake" : "RIFFfake"), { status: 200 })) as any,
    mail: async (m) => {
      sent.push(m);
      return extra.mailFail ? { ok: false, error: "500" } : { ok: true, id: `em_${sent.length}` };
    },
  });
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  async function post(pathname: string, body: Record<string, string>, sign = true) {
    const sig = twilioSignature(TOKEN, BASE + pathname, body);
    const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(sign ? { "x-twilio-signature": sig } : {}) },
      body: new URLSearchParams(body),
    });
    return { status: r.status, text: await r.text() };
  }
  return { post, sent, line, close: () => server.close() };
}

export const said = (twiml: string) => [...twiml.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)].map((m) => m[1]!.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'"));
export const actionOf = (twiml: string) => /action="([^"]+)"/.exec(twiml)?.[1]?.replace(BASE, "") ?? /<Redirect[^>]*>([^<]+)</.exec(twiml)?.[1]?.replace(BASE, "");
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
