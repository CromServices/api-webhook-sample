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
  // "ten forty two" / "forty-two": spoken pairs, as transcribers often write order numbers.
  const TEENS: Record<string, string> = {
    ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14",
    fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19",
  };
  const TENS: Record<string, string> = {
    twenty: "2", thirty: "3", forty: "4", fifty: "5", sixty: "6", seventy: "7", eighty: "8", ninety: "9",
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (TEENS[t]) tokens[i] = TEENS[t]!;
    else if (TENS[t]) {
      const unit = WORD_DIGITS[tokens[i + 1] ?? ""];
      if (unit && unit !== "0" && tokens[i + 1] !== "oh" && tokens[i + 1] !== "o") {
        tokens.splice(i, 2, TENS[t]! + unit);
      } else tokens[i] = TENS[t]! + "0";
    }
  }
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
