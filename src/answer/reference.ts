import { readOrderNumber, sayDigits, spokenDigits } from "../phone/normalise.ts";

/**
 * Order or job reference from what the caller said or keyed.
 * Digits reuse the phone line's order-number reader (one oh four two, a thousand and forty-two, #1042 ...).
 * Mixed references (letters and digits, e.g. "J K 4 4 1 9", "juliet kilo four four") are read letter by letter.
 */
const NATO: Record<string, string> = {
  alpha: "A", alfa: "A", bravo: "B", charlie: "C", delta: "D", echo: "E", foxtrot: "F", golf: "G", hotel: "H",
  india: "I", juliet: "J", kilo: "K", lima: "L", mike: "M", november: "N", oscar: "O", papa: "P", quebec: "Q",
  romeo: "R", sierra: "S", tango: "T", uniform: "U", victor: "V", whiskey: "W", whisky: "W", xray: "X",
  yankee: "Y", zulu: "Z",
};
const DIGIT_WORD = /^(zero|oh|nought|one|two|three|four|five|six|seven|eight|nine|double|triple)$/;
const NO_REF = /\b(no|don'?t|do not|haven'?t|none|not sure|no idea)\b.*\b(ref|reference|number|order|job|one|got|have)\b|^\s*(none|no|nope|nothing)\s*[.!]?\s*$/i;

export type Reference = { value: string; sure: boolean } | { value: "none"; sure: true };

export function saysNoReference(text: string): boolean {
  return NO_REF.test(text.trim());
}

export function readReference(input: string, digits?: string): Reference | null {
  const keyed = (digits ?? "").replace(/[^0-9]/g, "");
  if (keyed.length >= 3) return { value: keyed, sure: true };
  if (typeof input !== "string" || !input.trim() || input.length > 160) return null;
  if (saysNoReference(input)) return { value: "none", sure: true };
  // Lone letters count only when written as capitals (speech-to-text spells "J K 4 4" that way),
  // so "it's" or "a" never become part of a reference.
  const tokens = input
    .replace(/[xX]-ray/g, "xray")
    .replace(/'s\b/g, "s")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .replace(/\b([a-np-z])\b/g, "_")
    .toLowerCase()
    .replace(/_/g, "~")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // Longest run of reference pieces: single letters, NATO words, digits, digit words, mixed chunks (ab12).
  let best: string[] = [];
  let run: string[] = [];
  const piece = (t: string) => /^[a-z]$/.test(t) || NATO[t] !== undefined || /^\d+$/.test(t) || DIGIT_WORD.test(t) || /^(?=.*\d)(?=.*[a-z])[a-z0-9]{2,20}$/.test(t);
  for (const t of [...tokens, "|"]) {
    if (t !== "|" && piece(t)) run.push(t);
    else {
      if (run.length > best.length) best = run;
      run = [];
    }
  }
  const hasLetter = best.some((t) => /^[a-z]$/.test(t) || NATO[t] !== undefined || /[a-z]/.test(t) && /\d/.test(t));
  if (hasLetter) {
    let out = "";
    for (let i = 0; i < best.length; i++) {
      const t = best[i]!;
      if (NATO[t]) out += NATO[t];
      else if (/^[a-z]$/.test(t) && !(t === "o" && /\d/.test(out.slice(-1)))) out += t.toUpperCase();
      else if (/^[a-z0-9]+$/.test(t) && /[a-z]/.test(t) && /\d/.test(t)) out += t.toUpperCase();
      else if (t === "double" || t === "triple") {
        const nxt = best[i + 1];
        if (nxt) {
          const d = spokenDigits(nxt) || (NATO[nxt] ?? nxt.toUpperCase());
          out += d.repeat(t === "double" ? 2 : 3);
          i++;
        }
      } else out += spokenDigits(t);
    }
    // A stray article ("a") in front of a real number is not a letter.
    if (/^A\d{3,}$/.test(out) && /^a$/.test(best[0]!) && !/\b(alpha|letter a)\b/.test(input.toLowerCase())) out = out.slice(1);
    if (/^[A-Z0-9]{4,20}$/.test(out) && /\d/.test(out)) return { value: out, sure: false };
    if (/^[A-Z0-9]{4,20}$/.test(out)) return { value: out, sure: false };
  }
  const n = readOrderNumber(input);
  return n ? { value: n.number, sure: n.sure } : null;
}

const LETTER_NAME: Record<string, string> = { A: "A", H: "H", O: "O", Z: "zed" };
const DIGIT_NAMES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** "JK4419" -> "J, K, four, four, one, nine" for the read-back; digit-only refs use the phone line's reading. */
export function sayReference(value: string): string {
  if (/^\d+$/.test(value)) return sayDigits(value).replace(/-/g, ", ");
  return value
    .split("")
    .map((c) => (/\d/.test(c) ? DIGIT_NAMES[Number(c)] : LETTER_NAME[c] ?? c))
    .join(", ");
}
