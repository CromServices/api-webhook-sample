import { leadgenBody, type LeadgenNotice } from "./leadgen.ts";
import type { AttemptOutcome, Store } from "./store.ts";
import { signBody } from "../../shared/verify.ts";

export type DeliverInput = {
  url: string;
  secret: string;
  notice: LeadgenNotice;
  store: Store;
  retryDelayMs: number;
  timeoutMs: number;
  /** When set, this header is sent instead of a real signature. */
  signature?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * Posts one leadgen notice and, on a failed or slow delivery, tries once more.
 * A bad signature is not tried again.
 */
export async function deliverNotice(input: DeliverInput): Promise<void> {
  const raw = leadgenBody(input.notice);
  const signature = input.signature ?? `sha256=${signBody(input.secret, raw)}`;
  const maxTries = 2;
  for (let attempt = 0; attempt < maxTries; attempt += 1) {
    const waitedMs = attempt === 0 ? 0 : input.retryDelayMs;
    if (waitedMs > 0) await sleep(waitedMs);
    const started = Date.now();
    let status: number | null = null;
    let duplicate = false;
    try {
      const res = await fetch(input.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signature,
        },
        body: raw,
        signal: AbortSignal.timeout(input.timeoutMs),
      });
      status = res.status;
      if (status === 200) {
        const body = (await res.json()) as { duplicate?: unknown };
        duplicate = body.duplicate === true;
      }
    } catch {
      status = null;
    }
    const elapsedMs = Date.now() - started;
    let outcome: AttemptOutcome;
    if (status === 200) outcome = duplicate ? "duplicate" : "ok";
    else if (status === 401) outcome = "rejected";
    else if (status === 422) outcome = "unusable";
    else outcome = "down";
    input.store.logAttempt({
      at: new Date().toISOString(),
      leadgenId: input.notice.leadgenId,
      outcome,
      httpStatus: status,
      waitedMs,
      elapsedMs,
    });
    const retry = outcome === "down" && attempt < maxTries - 1;
    if (!retry) return;
  }
}
