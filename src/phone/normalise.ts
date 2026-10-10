/**
 * Turn what a caller says (or what the voice side heard) into comparable values.
 * Pure functions, no I/O.
 */

const WORD_DIGITS: Record<string, string> = {
  zero: "0",
  oh: "0",
  o: "0",
  nought: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

/**
 * Spoken digits to plain digits: "oh four nine one" -> "0491",
 * "double five" -> "55", "triple oh" -> "000". Anything else is dropped.
 */
export function spokenDigits(input: string): string {
  const tokens = input
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let out = "";
  let repeat = 1;
  for (const token of tokens) {
    if (token === "double") {
      repeat = 2;
      continue;
    }
    if (token === "triple") {
      repeat = 3;
      continue;
    }
    let digits = "";
    if (/^\+?\d+$/.test(token)) digits = token;
    else if (WORD_DIGITS[token] !== undefined) digits = WORD_DIGITS[token]!;
    if (!digits) {
      repeat = 1;
      continue;
    }
    if (repeat > 1 && digits.replace("+", "").length === 1) {
      out += digits.repeat(repeat);
    } else {
      out += digits;
    }
    repeat = 1;
  }
  return out;
}

/**
 * Australian phone numbers to one national form (0 + 9 digits).
 * Accepts +61 4xx xxx xxx, 61 4xx..., 0061 4xx..., +61 (0) 4xx..., (08) 5550 1234,
 * spoken digits. Returns null when it isn't a 10-digit Australian number.
 */
export function normaliseAuPhone(input: string): string | null {
  if (typeof input !== "string" || input.length > 80) return null;
  let raw = /[a-z]/i.test(input) ? spokenDigits(input) : input.replace(/[^\d+]/g, "");
  if (raw.startsWith("+")) raw = raw.slice(1);
  if (raw.startsWith("0061")) raw = raw.slice(4);
  else if (raw.startsWith("61") && raw.length >= 11) raw = raw.slice(2);
  else if (raw.startsWith("0")) raw = raw.slice(1);
  if (raw.startsWith("0")) raw = raw.slice(1); // "+61 (0) 4..." leaves a stray 0
  if (!/^[2-478]\d{8}$/.test(raw)) return null;
  return `0${raw}`;
}

/** Emails compare trimmed and case-insensitive. Spoken " at " / " dot " are accepted. */
export function normaliseEmail(input: string): string | null {
  if (typeof input !== "string" || input.length > 254) return null;
  let value = input.trim().toLowerCase();
  if (!value.includes("@")) {
    value = value.replace(/\s+at\s+/g, "@");
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    value = value.replace(/\s+dot\s+/g, ".").replace(/\s+/g, "");
  }
  value = value.replace(/\s+/g, "");
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(value) ? value : null;
}

/** A contact is an email if it has an @ (or a spoken "at"), otherwise a phone number. */
export function normaliseContact(
  input: string,
): { kind: "email"; value: string } | { kind: "phone"; value: string } | null {
  if (typeof input !== "string") return null;
  const looksEmail = input.includes("@") || /\s+at\s+.+\s+dot\s+/i.test(input);
  if (looksEmail) {
    const email = normaliseEmail(input);
    return email ? { kind: "email", value: email } : null;
  }
  const phone = normaliseAuPhone(input);
  return phone ? { kind: "phone", value: phone } : null;
}

/** "Order number 1042", "#1042", "one oh four two" -> "1042". 3 to 10 digits, else null. */
export function normaliseOrderNumber(input: string): string | null {
  if (typeof input !== "string" || input.length > 80) return null;
  const digits = /[a-z]/i.test(input.replace(/order|number|no\.?|hash|#/gi, ""))
    ? spokenDigits(input)
    : input.replace(/\D/g, "");
  return /^\d{3,10}$/.test(digits) ? digits : null;
}
