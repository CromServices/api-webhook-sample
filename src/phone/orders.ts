import { normaliseAuPhone, normaliseEmail } from "./normalise.ts";

/**
 * Where an order is, in words a caller understands. The phone line only ever
 * reads these. Nothing in src/phone can change an order.
 */
export type OrderStatus =
  | "received"
  | "being_made"
  | "ready_to_collect"
  | "on_its_way"
  | "delivered"
  | "on_hold";

export const STATUS_WORDS: Record<OrderStatus, { said: string; short: string }> = {
  received: { said: "We've got your order and it's in the queue.", short: "In the queue" },
  being_made: { said: "Your order is being made right now.", short: "Being made" },
  ready_to_collect: { said: "Your order is ready to collect.", short: "Ready to collect" },
  on_its_way: { said: "Your order is on its way to you.", short: "On its way" },
  delivered: { said: "Your order has been delivered.", short: "Delivered" },
  on_hold: {
    said: "Your order is on hold for the moment. Sam can tell you more.",
    short: "On hold",
  },
};

export type PhoneOrder = {
  number: string;
  item: string;
  phone: string;
  email: string;
  status: OrderStatus;
};

/** Read-only view of a shop's orders. A real shop swaps in its own (Wix, Woo) here. */
export type OrderSource = {
  find(number: string): Readonly<PhoneOrder> | undefined;
};

/**
 * Sam's Café sample order book for the phone line. Baked into the build, so it
 * is the same after every restart and redeploy (no disk, no volume).
 * Phone numbers are from ACMA's range set aside for fiction (0491 570 xxx and
 * (08) 5550 xxxx), and emails are on example.com, so none reach a real person.
 */
export const SAMPLE_ORDERS: readonly PhoneOrder[] = Object.freeze([
  { number: "1041", item: "Flat white", phone: "0491570006", email: "jess.t@example.com", status: "delivered" },
  { number: "1042", item: "Long black", phone: "0491570156", email: "Ari.K@Example.com", status: "on_its_way" },
  { number: "1043", item: "Banana bread", phone: "0855501234", email: "mel.r@example.com", status: "being_made" },
  { number: "1045", item: "Flat white and banana bread", phone: "0491570157", email: "dom.p@example.com", status: "ready_to_collect" },
  { number: "1046", item: "Two long blacks", phone: "0491570158", email: "lee.w@example.com", status: "received" },
  { number: "1047", item: "Banana bread", phone: "0491570159", email: "kim.n@example.com", status: "on_hold" },
].map((row) => Object.freeze({ ...row })) as PhoneOrder[]);

export function sampleOrderSource(rows: readonly PhoneOrder[] = SAMPLE_ORDERS): OrderSource {
  const byNumber = new Map(rows.map((row) => [row.number, row] as const));
  return {
    find(number) {
      return byNumber.get(number);
    },
  };
}

/** True only if the given contact is this order's phone or email. */
export function contactMatches(
  order: Readonly<PhoneOrder>,
  contact: { kind: "email" | "phone"; value: string },
): boolean {
  if (contact.kind === "phone") return normaliseAuPhone(order.phone) === contact.value;
  return normaliseEmail(order.email) === contact.value;
}
