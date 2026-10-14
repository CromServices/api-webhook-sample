/** Minimal Twilio REST helper for the test scripts. Credentials come from the env and are never printed. */
/** Numbers come from the env only (E.164, e.g. +618...), never from the repo. */
const e164 = (name: string) => {
  const v = (process.env[name] ?? "").replace(/\s+/g, "");
  if (!/^\+61\d{9}$/.test(v)) throw new Error(`refusing: ${name} missing or not an AU number in +61 form`);
  return v;
};
/** The shop line under test (SHOP_LINE_NUMBER). */
export const LINE_NUMBER = (): string => e164("SHOP_LINE_NUMBER");
/** Our own older number, the caller for scripted test calls (TEST_CALLER_NUMBER). */
export const TEST_CALLER_NUMBER = (): string => e164("TEST_CALLER_NUMBER");

const sid = () => process.env.TWILIO_ACCOUNT_SID ?? "";
const auth = () => "Basic " + Buffer.from(`${sid()}:${process.env.TWILIO_AUTH_TOKEN ?? ""}`).toString("base64");
export const api = (p: string) => `https://api.twilio.com/2010-04-01/Accounts/${sid()}${p}`;

export async function tw(p: string, form?: Record<string, string>): Promise<any> {
  const r = await fetch(api(p), {
    method: form ? "POST" : "GET",
    headers: { authorization: auth(), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Twilio ${r.status}: ${body.message ?? "error"}`);
  return body;
}

export async function download(url: string, file: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  const r = await fetch(url, { headers: { authorization: auth() } });
  if (!r.ok) throw new Error(`download ${r.status}`);
  await writeFile(file, Buffer.from(await r.arrayBuffer()));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitForCall(callSid: string, maxMs = 240_000): Promise<any> {
  const t = Date.now();
  for (;;) {
    const c = await tw(`/Calls/${callSid}.json`);
    if (["completed", "failed", "busy", "no-answer", "canceled"].includes(c.status)) return c;
    if (Date.now() - t > maxMs) {
      await tw(`/Calls/${callSid}.json`, { Status: "completed" });
      return tw(`/Calls/${callSid}.json`);
    }
    await sleep(3000);
  }
}

/** Twilio fills in price a little after the call ends. */
export async function waitForPrice(callSid: string, maxMs = 120_000): Promise<any> {
  const t = Date.now();
  for (;;) {
    const c = await tw(`/Calls/${callSid}.json`);
    if (c.price != null || Date.now() - t > maxMs) return c;
    await sleep(5000);
  }
}
