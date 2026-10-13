/**
 * Scripted test calls to the shop line. ONLY ever rings LINE_NUMBER (+61 8 6219 3046),
 * from our own TEST_CALLER_NUMBER (+61 8 5122 2255). The caller side is TwiML (<Say>/<Pause>); the line answers
 * through the deployed app. Writes calls-spend.csv; hard stop at A$40 running total.
 *   npx tsx scripts/test-calls.ts [scenario ...] [--out dir]
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (never printed), AUD_PER_USD (default 1.55, estimate).
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LINE_NUMBER, TEST_CALLER_NUMBER, download, tw, waitForCall, waitForPrice } from "./twilio-rest.ts";

const XAI_USD_PER_MIN = 0.08;
const AUD_PER_USD = Number(process.env.AUD_PER_USD ?? 1.55);
const CAP_AUD = 40;

const say = (t: string) => `<Say voice="Polly.Russell" language="en-AU">${t}</Say>`;
const pause = (s: number) => `<Pause length="${s}"/>`;

/** Caller side, timed against the line's prompts. Order 1042 / 0491 570 156 is sample data. */
export const CALLERS: Record<string, string> = {
  "happy-path": pause(11) + say("It's order ten forty two.") + pause(6) + say("Oh four nine one, five seven oh, one five six.") + pause(10) + say("No, that's all, thanks.") + pause(6),
  "wrong-order": pause(11) + say("It's order ten ninety nine.") + pause(6) + say("Oh four nine one, five seven oh, three one three.") + pause(9) + say("Ten ninety eight.") + pause(6) + say("Oh four nine one, five seven oh, three one three.") + pause(16) + say("Hi Sam, it's a test call, I think I've got the wrong order number.") + pause(5),
  "change-request": pause(11) + say("Ten forty five.") + pause(6) + say("dom dot p at example dot com.") + pause(10) + say("Can I change it to a long black instead?") + pause(16) + say("Hi Sam, test call, please change my coffee to a long black.") + pause(5),
  "ask-for-person": pause(11) + say("Can I just talk to Sam please?") + pause(16) + say("Hi Sam, this is a scripted test call. No need to call back.") + pause(5),
  "owner-no-answer": pause(11) + say("I need to cancel my banana bread order.") + pause(16) + say("Hi, it's a test call. Please cancel my banana bread. Thanks.") + pause(5),
};
CALLERS["check-call"] = pause(11) + say("Hi, it's order ten forty two.") + pause(6) + say("Oh four nine one, five seven oh, one five six.") + pause(10) + say("Actually, can I talk to Sam please?") + pause(16) + say("Hi Sam, this is the scripted check call about order ten forty two. No need to call back.") + pause(5);

async function main() {
  const args = process.argv.slice(2);
  const outI = args.indexOf("--out");
  const out = outI >= 0 ? args[outI + 1]! : "calls-out";
  const names = args.filter((a, i) => !a.startsWith("--") && i !== outI + 1);
  const csv = process.env.SPEND_CSV ?? "calls-spend.csv";
  mkdirSync(out, { recursive: true });
  if (!existsSync(csv)) appendFileSync(csv, "scenario,call_sid_suffix,status,seconds,twilio_price,twilio_unit,xai_est_usd,total_aud_est,running_aud_est\n");
  let running = Number(process.env.RUNNING_AUD ?? 0);
  for (const name of names) {
    const twiml = CALLERS[name];
    if (!twiml) throw new Error(`unknown scenario ${name}`);
    if (running >= CAP_AUD) {
      console.log(`hard stop: running total A$${running.toFixed(2)} >= A$${CAP_AUD}`);
      break;
    }
    const to = LINE_NUMBER;
    if (to !== "+61862193046" || TEST_CALLER_NUMBER !== "+61851222255") throw new Error("refusing: only the shop line may be called, from our own number");
    const call = await tw("/Calls.json", {
      To: to,
      From: TEST_CALLER_NUMBER,
      Twiml: `<Response>${twiml}<Hangup/></Response>`,
      Record: "true",
      RecordingChannels: "dual",
      TimeLimit: "180",
    });
    console.log(`${name}: placed (…${call.sid.slice(-6)})`);
    const done = await waitForCall(call.sid);
    const priced = await waitForPrice(call.sid);
    const secs = Number(done.duration ?? 0);
    const price = priced.price == null ? NaN : Math.abs(Number(priced.price));
    const unit = priced.price_unit ?? "";
    // The answering leg (inbound to the line) is billed separately; include it.
    const legs = await tw(`/Calls.json?ParentCallSid=${call.sid}`).catch(() => ({ calls: [] }));
    const inbound = await tw(`/Calls.json?To=${encodeURIComponent(to)}&StartTime>=${done.start_time?.slice(5, 16) ?? ""}&PageSize=5`).catch(() => ({ calls: [] }));
    let inboundPrice = 0;
    for (const c of inbound.calls ?? []) {
      if (c.sid !== call.sid && c.direction === "inbound" && Math.abs(new Date(c.start_time).getTime() - new Date(done.start_time).getTime()) < 20_000) {
        const p = await waitForPrice(c.sid, 60_000);
        inboundPrice += Math.abs(Number(p.price ?? 0));
        console.log(`  inbound leg …${c.sid.slice(-6)} price ${p.price ?? "pending"} ${p.price_unit ?? ""}`);
      }
    }
    void legs;
    const xaiUsd = (secs / 60) * XAI_USD_PER_MIN;
    const twilioAud = unit === "USD" ? (price + inboundPrice) * AUD_PER_USD : price + inboundPrice;
    const totalAud = (Number.isNaN(twilioAud) ? 0 : twilioAud) + xaiUsd * AUD_PER_USD;
    running += totalAud;
    appendFileSync(csv, [name, call.sid.slice(-6), done.status, secs, Number.isNaN(price) ? "pending" : (price + inboundPrice).toFixed(4), unit, xaiUsd.toFixed(4), totalAud.toFixed(4), running.toFixed(4)].join(",") + "\n");
    console.log(`  ${done.status}, ${secs}s, twilio ${price + inboundPrice} ${unit}, xai ~US$${xaiUsd.toFixed(3)}, running ~A$${running.toFixed(2)}`);
    const recs = await tw(`/Calls/${call.sid}/Recordings.json`).catch(() => ({ recordings: [] }));
    for (const r of recs.recordings ?? []) {
      const file = path.join(out, `${name}.wav`);
      await download(`https://api.twilio.com${r.uri.replace(/\.json$/, ".wav")}`, file).catch((e) => console.log("  recording:", e.message));
      console.log(`  recording -> ${file} (${r.channels} ch, ${r.duration}s)`);
    }
    console.log(`  call start ${done.start_time}`);
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
