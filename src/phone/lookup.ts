import { normaliseContact, normaliseOrderNumber } from "./normalise.ts";
import { STATUS_WORDS, contactMatches, type OrderSource, type OrderStatus } from "./orders.ts";

/** The only two shapes the phone line ever gets back. */
export type LookupResult =
  | { match: true; status: OrderStatus; say: string }
  | { match: false; say: string };

export const NO_MATCH_SAY =
  "Sorry, I couldn't match those details to an order.";

const NO_MATCH: LookupResult = Object.freeze({ match: false, say: NO_MATCH_SAY });

/**
 * Status only, and only when the contact belongs to the order. Wrong order,
 * wrong contact, bad input: all give the same answer, so a caller can't tell
 * which part was wrong. Reads only; never writes.
 */
export function lookupOrder(source: OrderSource, orderInput: unknown, contactInput: unknown): LookupResult {
  if (typeof orderInput !== "string" || typeof contactInput !== "string") return NO_MATCH;
  const number = normaliseOrderNumber(orderInput);
  const contact = normaliseContact(contactInput);
  if (!number || !contact) return NO_MATCH;
  const order = source.find(number);
  if (!order || !contactMatches(order, contact)) return NO_MATCH;
  return { match: true, status: order.status, say: STATUS_WORDS[order.status].said };
}

/**
 * Fixed-window counter. In memory on purpose: limits reset with the process,
 * which is fine for a guard (nothing to keep).
 */
export function createRateLimiter(opts: { limit: number; windowMs: number; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, { start: number; count: number }>();
  return {
    /** Counts one hit. Returns false once the key is over its limit for this window. */
    take(key: string): boolean {
      const t = now();
      const row = hits.get(key);
      if (!row || t - row.start >= opts.windowMs) {
        hits.set(key, { start: t, count: 1 });
        if (hits.size > 10_000) {
          for (const [k, v] of hits) if (t - v.start >= opts.windowMs) hits.delete(k);
        }
        return true;
      }
      row.count += 1;
      return row.count <= opts.limit;
    },
    /** True if the key is already over its limit, without counting a hit. */
    blocked(key: string): boolean {
      const row = hits.get(key);
      if (!row || now() - row.start >= opts.windowMs) return false;
      return row.count >= opts.limit;
    },
  };
}
