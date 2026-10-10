import { timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { openCallLog, type CallLog } from "./calllog.ts";
import { createRateLimiter, lookupOrder, NO_MATCH_SAY } from "./lookup.ts";
import { normaliseOrderNumber } from "./normalise.ts";
import { sampleOrderSource, type OrderSource } from "./orders.ts";
import { callLogPage } from "./page.ts";

export type PhoneLineOptions = {
  /** Shared secret the voice side sends in x-phone-line-key. Empty = lookup closed (404). */
  lookupKey?: string;
  /** Call log page login. Either empty = page closed (404). */
  viewUser?: string;
  viewPassword?: string;
  orders?: OrderSource;
  callLog?: CallLog;
  timeZone?: string;
  /** Lookups per minute for the whole line. */
  perMinute?: number;
  /** Failed lookups per order number before it is held for the window. */
  failsPerOrder?: number;
  failWindowMs?: number;
  now?: () => number;
};

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function basicOk(user: string, password: string, header: string | undefined): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  const userOk = same(decoded.slice(0, i), user);
  const passOk = same(decoded.slice(i + 1), password);
  return userOk && passOk;
}

/**
 * Phone line routes. Both are closed (404) unless their secrets are set, so
 * the demo behaves exactly as before when nothing is configured.
 *   POST /phone/lookup  read-only order status for the voice side
 *   GET  /calls         private call log page
 */
export function mountPhoneLine(app: Express, opts: PhoneLineOptions = {}): { callLog: CallLog } {
  const orders = opts.orders ?? sampleOrderSource();
  const callLog = opts.callLog ?? openCallLog();
  const lookupKey = opts.lookupKey ?? "";
  const now = opts.now ?? Date.now;
  const perLine = createRateLimiter({ limit: opts.perMinute ?? 30, windowMs: 60_000, now });
  const perOrder = createRateLimiter({
    limit: opts.failsPerOrder ?? 5,
    windowMs: opts.failWindowMs ?? 15 * 60_000,
    now,
  });

  app.post("/phone/lookup", (req: Request, res: Response) => {
    res.set("cache-control", "no-store");
    if (!lookupKey) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (!same(req.header("x-phone-line-key") ?? "", lookupKey)) {
      res.status(401).json({ error: "not allowed" });
      return;
    }
    const ip = req.header("fly-client-ip") ?? req.ip ?? "unknown";
    if (!perLine.take(`line:${ip}`)) {
      res.status(429).json({ error: "slow down" });
      return;
    }
    const orderNumber = req.body?.orderNumber;
    const contact = req.body?.contact;
    const number = typeof orderNumber === "string" ? normaliseOrderNumber(orderNumber) : null;
    // An order number that has had too many wrong tries gets the same
    // "couldn't match" as anything else, so the limit gives nothing away.
    if (number && perOrder.blocked(`order:${number}`)) {
      res.status(200).json({ match: false, say: NO_MATCH_SAY });
      return;
    }
    const result = lookupOrder(orders, orderNumber, contact);
    if (!result.match && number) perOrder.take(`order:${number}`);
    res.status(200).json(result.match ? { match: true, status: result.status, say: result.say } : { match: false, say: result.say });
  });

  app.get("/calls", (req: Request, res: Response) => {
    const user = opts.viewUser ?? "";
    const password = opts.viewPassword ?? "";
    res.set("cache-control", "no-store");
    if (!user || !password) {
      res.status(404).type("text").send("Not found");
      return;
    }
    if (!basicOk(user, password, req.header("authorization") ?? undefined)) {
      res.set("www-authenticate", 'Basic realm="Calls", charset="UTF-8"');
      res.status(401).type("text").send("Sign in to see calls.");
      return;
    }
    res.status(200).type("html").send(callLogPage(callLog.list(), opts.timeZone));
  });

  return { callLog };
}
