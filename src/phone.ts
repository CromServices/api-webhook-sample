/**
 * Australian numbers as people write them, stored as a single spaced form.
 * Mobiles: 0400 000 101. Landlines: 02 0000 0000.
 * Returns null when the digits are not an Australian number.
 */
export function normaliseAuPhone(input: string): string | null {
  let digits = input.trim().replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("61") && digits.length === 11) digits = `0${digits.slice(2)}`;
  if (!/^0[23478]\d{8}$/.test(digits)) return null;
  if (digits.startsWith("04")) {
    return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  return `${digits.slice(0, 2)} ${digits.slice(2, 6)} ${digits.slice(6)}`;
}
