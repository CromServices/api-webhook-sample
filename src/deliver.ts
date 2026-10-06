import { signBody } from "./verify.ts";
import type { ShopOrder, Store } from "./store.ts";

export type DeliveryDeps = {
  secret: string;
  webhookUrl: () => string;
  delaysMs: number[];
  clientTimeoutMs: number;
  store: Store;
  inflight: Set<string>;
};

export function orderPayload(order: { id: string; product: string; qty: number }): string {
  return JSON.stringify({
    kind: "order",
    id: order.id,
    product: order.product,
    qty: order.qty,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function delayBefore(attempt: number, delaysMs: number[]): number {
  if (attempt === 0) return 0;
  const index = Math.min(attempt - 1, Math.max(delaysMs.length - 1, 0));
  return delaysMs[index] ?? 1000;
}

export function startDelivery(
  order: Pick<ShopOrder, "id" | "product" | "qty">,
  deps: DeliveryDeps,
): void {
  if (deps.inflight.has(order.id)) return;
  deps.inflight.add(order.id);
  const generation = deps.store.generation();
  void run(order, deps, generation).finally(() => {
    deps.inflight.delete(order.id);
  });
}

async function run(
  order: Pick<ShopOrder, "id" | "product" | "qty">,
  deps: DeliveryDeps,
  generation: number,
): Promise<void> {
  let attempt = 0;
  for (;;) {
    if (deps.store.generation() !== generation) return;
    const waitedMs = delayBefore(attempt, deps.delaysMs);
    if (waitedMs > 0) await sleep(waitedMs);
    if (deps.store.generation() !== generation) return;
    const at = new Date().toISOString();
    let status: number | null = null;
    let duplicate = false;
    try {
      const raw = orderPayload(order);
      const res = await fetch(deps.webhookUrl(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature-256": signBody(deps.secret, raw),
        },
        body: raw,
        signal: AbortSignal.timeout(deps.clientTimeoutMs),
      });
      status = res.status;
      if (status === 200) {
        const body = (await res.json()) as { duplicate?: unknown };
        duplicate = body.duplicate === true;
      }
    } catch {
      status = null;
    }
    if (deps.store.generation() !== generation) return;
    if (status === 401 || status === 409 || status === 400) return;
    const outcome = status === 200 ? (duplicate ? "duplicate" : "ok") : "down";
    deps.store.logAttempt({
      at,
      orderId: order.id,
      product: order.product,
      qty: order.qty,
      outcome,
      httpStatus: status,
      waitedMs,
    });
    if (outcome === "ok" || outcome === "duplicate") return;
    attempt += 1;
  }
}
