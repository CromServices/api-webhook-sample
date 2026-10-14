import { readFileSync } from "node:fs";
import type { State } from "./store.ts";

/**
 * The shop sample, both ways, through the same routes the pages use.
 * The stored file this leaves behind is the committed cold-boot fixture.
 */
export async function runBoth(base: string, token: string, dataPath: string): Promise<void> {
  async function admin(route: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${base}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`${route} failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  async function place(product: string, qty = 1): Promise<void> {
    const res = await fetch(`${base}/shop/orders`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `product=${encodeURIComponent(product)}&qty=${qty}`,
      redirect: "manual",
    });
    if (res.status !== 303) {
      throw new Error(`place ${product} failed (${res.status})`);
    }
  }

  function readState(): State {
    return JSON.parse(readFileSync(dataPath, "utf8")) as State;
  }

  async function waitFor<T>(read: () => T | null, ms = 8000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const value = read();
      if (value) return value;
      if (Date.now() - start > ms) throw new Error("timed out waiting for the shop run");
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  await admin("/admin/mode", { mode: "old" });
  await place("Flat white");
  await waitFor(() => (readState().stockOrders.some((row) => row.product === "Flat white") ? true : null));
  await admin("/admin/slow", { ms: 250 });
  await place("Long black");
  await waitFor(() => {
    const rows = readState().stockOrders.filter((row) => row.product === "Long black");
    return rows.length === 2 ? true : null;
  });
  await admin("/admin/slow", { ms: 0 });
  const missing = await admin("/admin/bad-delivery", {
    product: "Banana bread",
    qty: 1,
    onShop: true,
  });
  if (typeof missing.id !== "string") throw new Error("bad delivery did not return an id");
  await admin("/admin/snapshot", { name: "before" });

  await admin("/admin/reset", { mode: "fixed" });
  await place("Flat white");
  const first = await waitFor(() => {
    const state = readState();
    const row = state.shopOrders.find((order) => order.product === "Flat white");
    if (row && state.stockOrders.some((stock) => stock.id === row.id)) return row;
    return null;
  });
  await admin("/admin/stock", { up: false });
  await place("Long black");
  await waitFor(() =>
    readState().attempts.some((row) => row.product === "Long black" && row.outcome === "down") ? true : null,
  );
  await admin("/admin/stock", { up: true });
  await waitFor(() => (readState().stockOrders.filter((row) => row.product === "Long black").length === 1 ? true : null));
  await place("Banana bread");
  await waitFor(() => (readState().stockOrders.some((row) => row.product === "Banana bread") ? true : null));
  await admin("/admin/resend", { id: first.id });
  await waitFor(() =>
    readState().attempts.some((row) => row.orderId === first.id && row.outcome === "duplicate") ? true : null,
  );
  await admin("/admin/bad-delivery", { product: "Flat white", qty: 1, onShop: false });
  await admin("/admin/snapshot", { name: "after" });
}
