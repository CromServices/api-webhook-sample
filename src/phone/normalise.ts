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
  let value = input.trim().toLowerCase().replace(/[.!?,;]+\s*$/, "");
  // Spoken lead-ins: "yeah it's ...", "my email is ...", "that's ..."
  value = value.replace(
    /^((yeah|yep|yes|um+|uh+|so|okay|ok)[,.]?\s+)*((it'?s|it is|that'?s|that is|(my |the )?email( address)? is|(my |the )?email:?)\s+)+/,
    "",
  );
  // Spoken punctuation in the local part / domain.
  value = value.replace(/\s+(underscore)\s+/g, "_").replace(/\s+(dash|hyphen)\s+/g, "-");
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
const UNITS: Record<string, number> = {
  zero: 0, oh: 0, o: 0, nought: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const TENS_N: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/**
 * "a thousand and forty-two", "one thousand forty two", "1 thousand 42", "ten hundred and 42"
 * -> 1042. Only used when the caller said "thousand" or "hundred". Null if it doesn't add up.
 */
function cardinal(tokens: string[]): number | null {
  let total = 0;
  let current = 0;
  let seen = false;
  for (const t of tokens) {
    if (t === "and") continue;
    if (t === "a" || t === "an") {
      current = current || 1;
      continue;
    }
    if (/^\d+$/.test(t)) {
      current += Number(t);
      seen = true;
    } else if (UNITS[t] !== undefined) {
      current += UNITS[t]!;
      seen = true;
    } else if (TENS_N[t] !== undefined) {
      current += TENS_N[t]!;
      seen = true;
    } else if (t === "hundred") {
      current = (current || 1) * 100;
      seen = true;
    } else if (t === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
      seen = true;
    } else return null;
  }
  return seen ? total + current : null;
}

const NUMBERISH = /^(\d+|and|a|an|hundred|thousand|zero|oh|o|nought|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|double|triple)$/;

export type OrderNumberReading = {
  number: string;
  /** False when the caller said it as a quantity or in pairs ("a thousand and 42", "ten forty-two"):
   *  speech-to-text often gets those wrong, so the line reads it back first. */
  sure: boolean;
};

/**
 * Reads an order number out of what the caller said, in any of:
 * "1042", "one zero four two", "one oh four two", "ten forty-two", "a thousand and forty-two",
 * "one thousand forty two", "a thousand and 42", "1 thousand 42", "order #1042".
 */
export function readOrderNumber(input: string): OrderNumberReading | null {
  if (typeof input !== "string" || input.length > 120) return null;
  const tokens = input
    .toLowerCase()
    .replace(/(\d),(\d)/g, "$1$2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // Longest run of number words / digits (filler like "it's order ... please" falls outside it).
  let best: string[] = [];
  let run: string[] = [];
  for (const t of [...tokens, "|"]) {
    if (NUMBERISH.test(t)) run.push(t);
    else {
      while (run.length && /^(and|a|an)$/.test(run[run.length - 1]!)) run.pop();
      while (run.length && /^(and)$/.test(run[0]!)) run.shift();
      const digitsIn = run.filter((x) => x !== "and" && x !== "a" && x !== "an").length;
      const bestIn = best.filter((x) => x !== "and" && x !== "a" && x !== "an").length;
      if (digitsIn > bestIn) best = run;
      run = [];
    }
  }
  if (!best.length) return null;
  let number: string | null;
  let sure: boolean;
  if (best.some((t) => t === "thousand" || t === "hundred")) {
    // Stutters: "a thousand, a thousand, thousand and forty-two" -> take the last "thousand" phrase only.
    const at: number[] = [];
    best.forEach((t, i) => t === "thousand" && at.push(i));
    if (at.length > 1) best = best.slice(at[at.length - 2]! + 1);
    const n = cardinal(best);
    number = n === null ? null : String(n);
    sure = false;
  } else {
    const words = best.filter((t) => t !== "and" && t !== "a" && t !== "an");
    number = spokenDigits(words.join(" "));
    // Plain digits or digit-by-digit words are sure; pairs like "ten forty-two" are not.
    sure = words.every((t) => /^\d+$/.test(t) || WORD_DIGITS[t] !== undefined || t === "double" || t === "triple");
  }
  if (!number || !/^\d{3,10}$/.test(number)) return null;
  return { number, sure };
}

/** "1042" from anything readOrderNumber understands; null otherwise. */
export function normaliseOrderNumber(input: string): string | null {
  return readOrderNumber(input)?.number ?? null;
}

/** "1042" -> "one-oh-four-two", for reading a number back. */
export function sayDigits(number: string): string {
  const names = ["oh", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  return number
    .split("")
    .map((d) => names[Number(d)])
    .join("-");
}
