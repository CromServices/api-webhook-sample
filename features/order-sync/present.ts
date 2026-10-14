import { checkedLine, madeArrived, onHandLine, orderLine, STORY } from "./story.ts";
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
  const missed = mine.some((row) => row.outcome === "down" || row.outcome === "rejected");
  const ok = mine.some((row) => row.outcome === "ok");
  if (stockCount >= 2) return STORY.arrivedTwice;
  if (stockCount === 1 && missed && ok) return STORY.sentAgain;
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
      when: "",
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
    const arrivedLater =
      attempt.outcome === "rejected" &&
      picture.stockOrders.some((row) => row.id === attempt.orderId) &&
      picture.attempts.some((row) => row.orderId === attempt.orderId && row.outcome === "ok");
    if (arrivedLater) continue;
    const label = attempt.outcome === "duplicate" ? STORY.duplicateStopped : STORY.rejected;
    extras.push({
      at: attempt.at,
      text: `${orderLine(attempt.orderId, attempt.qty, attempt.product)}. ${label}.`,
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

export type TriageFinding = {
  summary: string;
  orders: string[];
};

export type TriageView = {
  checked: string;
  found: TriageFinding[];
  fixed: string[];
  later: string | null;
};

function stockCount(picture: Picture, id: string): number {
  return picture.stockOrders.filter((row) => row.id === id).length;
}

/** Plain triage of one stored run. Counts and order lines come from that run. */
export function triageFrom(picture: Picture | null): TriageView {
  if (!picture) {
    return { checked: checkedLine(0, 0), found: [], fixed: [], later: null };
  }
  const made = picture.shopOrders.length;
  const arrived = new Set(picture.stockOrders.map((row) => row.id)).size;
  const never = picture.shopOrders.filter((order) => stockCount(picture, order.id) === 0);
  const twice = picture.shopOrders.filter((order) => stockCount(picture, order.id) >= 2);
  const turnedAwayIds = [
    ...new Set(
      picture.attempts.filter((row) => row.outcome === "rejected").map((row) => row.orderId),
    ),
  ];
  const found: TriageFinding[] = [];
  if (never.length > 0) {
    found.push({
      summary: `${never.length} never arrived`,
      orders: never.map((order) => orderLine(order.id, order.qty, order.product)),
    });
  }
  if (twice.length > 0) {
    found.push({
      summary: `${twice.length} arrived twice`,
      orders: twice.map((order) => orderLine(order.id, order.qty, order.product)),
    });
  }
  if (turnedAwayIds.length > 0) {
    found.push({
      summary: `${turnedAwayIds.length} not from your shop`,
      orders: turnedAwayIds.map((id) => {
        const attempt = picture.attempts.find((row) => row.orderId === id && row.outcome === "rejected");
        return orderLine(id, attempt?.qty ?? 1, attempt?.product ?? "");
      }),
    });
  }
  const fixed: string[] = [];
  if (never.length > 0) fixed.push(STORY.fixedMissing);
  if (twice.length > 0) fixed.push(STORY.fixedDuplicates);
  if (never.length > 0 || turnedAwayIds.length > 0) fixed.push(STORY.fixedTurnedAway);
  const hasWork = made > 0 || arrived > 0 || picture.attempts.length > 0;
  return {
    checked: checkedLine(made, arrived),
    found,
    fixed,
    later: hasWork && !STORY.earlierOrdersCopied ? STORY.laterNotCopied : null,
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
    const missed = sorted.some((row) => row.outcome === "down" || row.outcome === "rejected");
    const ok = sorted.find((row) => row.outcome === "ok");
    if (ok && missed) {
      lines.push({ at: ok.at, text: `${text}. ${STORY.sentAgain}.` });
    } else if (ok) {
      lines.push({ at: ok.at, text: `${text}. ${STORY.arrived}.` });
    }
    for (const attempt of sorted) {
      if (attempt.outcome === "duplicate") {
        lines.push({
          at: attempt.at,
          text: `${text}. ${STORY.duplicateStopped}.`,
        });
      }
      if (attempt.outcome === "rejected" && !ok) {
        lines.push({
          at: attempt.at,
          text: `${text}. ${STORY.rejected}.`,
        });
      }
    }
  }
  lines.sort((a, b) => a.at.localeCompare(b.at));
  return lines.map((row) => row.text);
}
