import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Compute hex HMAC-SHA256 of rawBody with secret.
 */
export function signBody(secret: string, rawBody: string | Buffer): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Verify header value against expected HMAC.
 * Accepts either raw hex or a "sha256=<hex>" prefix (common webhook style).
 */
export function verifyHmacHeader(
  secret: string,
  rawBody: string | Buffer,
  headerValue: string | undefined,
): boolean {
  if (!headerValue || !secret) return false;

  const provided = headerValue.startsWith("sha256=")
    ? headerValue.slice("sha256=".length)
    : headerValue;

  const expected = signBody(secret, rawBody);

  try {
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
