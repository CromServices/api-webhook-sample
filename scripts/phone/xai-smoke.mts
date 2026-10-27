/**
 * Tiny real check of the xAI voice provider (about 10-20 s of session, ~US$0.03).
 *   XAI_API_KEY=... npx tsx scripts/xai-smoke.mts
 * 1. speak a fixed line with force_message (our TTS path), μ-law out
 * 2. feed that audio back in as the "caller", plus silence, μ-law in
 * 3. expect input transcription back (our ASR path) and no model audio passed through
 * Prints timings and an estimated cost (US$0.08/min, xAI pricing). Never prints the key.
 */
import { XaiVoiceProvider } from "../../src/phone/voice/xai.ts";

const key = process.env.XAI_API_KEY ?? "";
if (!key) {
  console.error("XAI_API_KEY not set");
  process.exit(2);
}
const t0 = Date.now();
const audio: string[] = [];
let heard = "";
let errors: string[] = [];
let gotHeard: () => void = () => {};
const heardP = new Promise<void>((r) => (gotHeard = r));
const provider = new XaiVoiceProvider({ apiKey: key });
const hardStop = setTimeout(() => {
  console.error("smoke: hard stop at 30 s");
  process.exit(1);
}, 30_000);

const session = await provider.start({
  onAudio: (b) => audio.push(b),
  onHeard: (t) => {
    heard = t;
    gotHeard();
  },
  onError: (m) => errors.push(m),
});
const tReady = Date.now();
const line = "Hi, it's order ten forty two, and my number is oh four nine one, five seven oh, one five six.";
await session.say(line);
const tSaid = Date.now();
const bytes = audio.reduce((n, b) => n + Buffer.from(b, "base64").length, 0);
const spokenAudio = audio.length;

// Feed it back in 20 ms frames (160 bytes μ-law) like Twilio, then 1.5 s of silence.
const all = Buffer.concat(audio.map((b) => Buffer.from(b, "base64")));
const frames: Buffer[] = [];
for (let i = 0; i < all.length; i += 160) frames.push(all.subarray(i, i + 160));
for (let i = 0; i < 75; i += 1) frames.push(Buffer.alloc(160, 0xff));
// xAI ignores input while its own forced line would still be playing, so wait that out first (like a caller listening).
await new Promise((r) => setTimeout(r, Math.max(0, (bytes / 8000) * 1000 - (Date.now() - tReady)) + 500));
for (const f of frames) {
  session.sendAudio(f.toString("base64"));
  await new Promise((r) => setTimeout(r, 20));
}
await Promise.race([heardP, new Promise((r) => setTimeout(r, 10_000))]);
const tHeard = Date.now();
const passedThrough = audio.length - spokenAudio;
await session.end();
clearTimeout(hardStop);
const secs = (Date.now() - t0) / 1000;
const result = {
  connectMs: tReady - t0,
  ttsMs: tSaid - tReady,
  ttsAudioSeconds: +(bytes / 8000).toFixed(2),
  transcriptionMs: tHeard - tSaid,
  heard,
  modelAudioPassedThrough: passedThrough,
  errors,
  sessionSeconds: +secs.toFixed(1),
  estCostUsd: +((secs / 60) * 0.08).toFixed(4),
};
console.log(JSON.stringify(result, null, 2));
process.exit(heard && bytes > 0 ? 0 : 1);
