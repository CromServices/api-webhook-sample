/**
 * Customer-facing words for the demo shop. Change labels here only.
 * Order numbers, counts and times come from stored runs, not from this file.
 */
export const STORY = {
  pageTitle: "Shop-to-stock order sync: sample",
  h1: "Connect your systems",
  lead: "Place an order once. It shows in the online shop and in stock.",
  before: "Before",
  after: "After",
  shop: "Online shop",
  stock: "Stock",
  history: "What happened",
  both: "Shop and stock",
  sideBySide: "Before and after",
  triageTitle: "What we checked",
  foundTitle: "What we found",
  fixedTitle: "What we fixed first",
  laterTitle: "Flagged for later",
  nothingFound: "Nothing out of place.",
  fixedMissing: "Missing orders first, because a missing order is a lost sale.",
  fixedDuplicates: "Duplicates next, because they make the stock count wrong.",
  fixedTurnedAway: "Then a turned-away order is noted, so it is not lost.",
  /**
   * Earlier orders are not loaded into the shop. The triage page says so
   * because that is true, not because a row was typed in.
   */
  earlierOrdersCopied: false,
  laterNotCopied: "Orders from before the switch-on weren't copied across.",
  none: "No orders yet.",
  historyEmpty: "Nothing has happened yet.",
  place: "Place order",
  product: "Product",
  quantity: "Quantity",
  arrived: "Arrived in stock",
  sentAgain: "Didn't arrive, sent again, arrived",
  arrivedTwice: "Arrived twice",
  neverArrived: "Never arrived",
  duplicateStopped: "Duplicate stopped",
  rejected: "Rejected, not from your shop",
  products: [
    { name: "Flat white", onHand: 12 },
    { name: "Long black", onHand: 12 },
    { name: "Banana bread", onHand: 12 },
  ],
  nav: [
    { href: "/", label: "Shop and stock" },
    { href: "/shop", label: "Online shop" },
    { href: "/stock", label: "Stock" },
    { href: "/history", label: "What happened" },
    { href: "/demo", label: "Before and after" },
    { href: "/demo?view=triage", label: "What we checked" },
  ],
} as const;

export function madeArrived(made: number, arrived: number): string {
  return `Made ${made}. Arrived ${arrived}.`;
}

export function checkedLine(made: number, arrived: number): string {
  return `Orders made: ${made}. Orders that arrived in stock: ${arrived}.`;
}

export function orderLine(id: string, qty: number, product: string): string {
  return `Order #${id}: ${qty} x ${product}`;
}

export function onHandLine(name: string, onHand: number, sent: number, took: number): string {
  return `${name}: ${onHand} on hand. Shop sent ${sent}. Stock took ${took}.`;
}
