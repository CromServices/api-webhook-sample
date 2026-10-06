import { madeArrived, onHandLine, orderLine, STORY } from "./story.ts";
import type { Picture, ShopOrder } from "./store.ts";

export type ViewRow = {
  text: string;
  when: string;
  label: string;
  soft: boolean;
};

export type View = {
  headline: string;
  orders: ViewRow[];
  products: string[];
  extras: { text: string }[];
};

export function humanTime(iso: string): string {
  const formatted = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
  return formatted.replace(/\u202f/g, " ").replace(/\u00a0/g, " ").toLowerCase();
}

function labelFor(order: ShopOrder, picture: Picture): string {
  const stockCount = picture.stockOrders.filter((row) => row.id === order.id).length;
  const mine = picture.attempts.filter((row) => row.orderId === order.id);
  const down = mine.some((row) => row.outcome === "down");
  const ok = mine.some((row) => row.outcome === "ok");
  if (stockCount >= 2) return STORY.arrivedTwice;
  if (stockCount === 1 && down && ok) return STORY.sentAgain;
  if (stockCount === 1) return STORY.arrived;
  if (mine.some((row) => row.outcome === "rejected")) return STORY.rejected;
  return STORY.neverArrived;
}

export function present(picture: Picture): View {
  const made = picture.shopOrders.length;
  const arrived = new Set(picture.stockOrders.map((row) => row.id)).size;
  const orders: ViewRow[] = picture.shopOrders.map((order) => {
    const label = labelFor(order, picture);
    return {
      text: orderLine(order.id, order.qty, order.product),
      when: humanTime(order.placedAt),
      label,
      soft: label === STORY.arrivedTwice || label === STORY.neverArrived,
    };
  });
  const products = picture.products.map((product) => {
    const sent = picture.shopOrders
      .filter((row) => row.product === product.name)
      .reduce((sum, row) => sum + row.qty, 0);
    const took = picture.stockOrders
      .filter((row) => row.product === product.name)
      .reduce((sum, row) => sum + row.qty, 0);
    return onHandLine(product.name, product.onHand, sent, took);
  });
  const extras: { at: string; text: string }[] = [];
  for (const attempt of picture.attempts) {
    if (attempt.outcome !== "duplicate" && attempt.outcome !== "rejected") continue;
    const label = attempt.outcome === "duplicate" ? STORY.duplicateStopped : STORY.rejected;
    extras.push({
      at: attempt.at,
      text: `${humanTime(attempt.at)} · ${orderLine(attempt.orderId, attempt.qty, attempt.product)}. ${label}.`,
    });
  }
  extras.sort((a, b) => a.at.localeCompare(b.at));
  return {
    headline: madeArrived(made, arrived),
    orders,
    products,
    extras: extras.map((row) => ({ text: row.text })),
  };
}

export function historyLines(picture: Picture): string[] {
  const grouped = new Map<string, Picture["attempts"]>();
  for (const attempt of picture.attempts) {
    const list = grouped.get(attempt.orderId) ?? [];
    list.push(attempt);
    grouped.set(attempt.orderId, list);
  }
  const lines: { at: string; text: string }[] = [];
  for (const [id, list] of grouped) {
    const sorted = [...list].sort((a, b) => a.at.localeCompare(b.at));
    const first = sorted[0];
    if (!first) continue;
    const text = orderLine(id, first.qty, first.product);
    const down = sorted.some((row) => row.outcome === "down");
    const ok = sorted.find((row) => row.outcome === "ok");
    if (ok && down) {
      lines.push({ at: ok.at, text: `${humanTime(ok.at)} · ${text}. ${STORY.sentAgain}.` });
    } else if (ok) {
      lines.push({ at: ok.at, text: `${humanTime(ok.at)} · ${text}. ${STORY.arrived}.` });
    }
    for (const attempt of sorted) {
      if (attempt.outcome === "duplicate") {
        lines.push({
          at: attempt.at,
          text: `${humanTime(attempt.at)} · ${text}. ${STORY.duplicateStopped}.`,
        });
      }
      if (attempt.outcome === "rejected") {
        lines.push({
          at: attempt.at,
          text: `${humanTime(attempt.at)} · ${text}. ${STORY.rejected}.`,
        });
      }
    }
  }
  lines.sort((a, b) => a.at.localeCompare(b.at));
  return lines.map((row) => row.text);
}
