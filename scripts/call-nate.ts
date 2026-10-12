/**
 * ONE outbound demo call from the shop line to Nate's mobile. Not run by tests.
 * The number is only ever read from the env (NATE_TEST_NUMBER); it is never in the repo or logs.
 * The answered call is sent to /phone/voice, so Nate hears the same greeting and flow as a caller.
 *   NATE_TEST_NUMBER=... npx tsx scripts/call-nate.ts --yes-call-nate-once
 */
import { LINE_NUMBER, tw, waitForCall, waitForPrice } from "./twilio-rest.ts";

const BASE = process.env.PUBLIC_BASE_URL ?? "https://crom-phone-line-sample.fly.dev";
const target = (process.env.NATE_TEST_NUMBER ?? "").replace(/\s+/g, "");

async function main() {
  if (!process.argv.includes("--yes-call-nate-once")) throw new Error("refusing: pass --yes-call-nate-once");
  if (!/^\+614\d{8}$/.test(target)) throw new Error("refusing: NATE_TEST_NUMBER missing or not an AU mobile in +614… form");
  const allowed = (process.env.NATE_TEST_NUMBER ?? "").replace(/\s+/g, "");
  if (target !== allowed || target === LINE_NUMBER) throw new Error("refusing: target is not NATE_TEST_NUMBER");
  const call = await tw("/Calls.json", {
    To: target,
    From: LINE_NUMBER,
    Url: `${BASE}/phone/voice`,
    Method: "POST",
    Record: "true",
    RecordingChannels: "dual",
    TimeLimit: "300",
  });
  console.log(`placed one call (…${call.sid.slice(-6)}) to NATE_TEST_NUMBER`);
  const done = await waitForCall(call.sid, 360_000);
  const priced = await waitForPrice(call.sid);
  console.log(`${done.status}, ${done.duration}s, price ${priced.price ?? "pending"} ${priced.price_unit ?? ""}`);
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
