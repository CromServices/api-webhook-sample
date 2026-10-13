/**
 * Customer-facing words. Counts, names and dates come from stored runs.
 */
export const STORY = {
  pageTitle: "Ad leads into your sheet: sample",
  shopName: "Sam's Café · catering leads",
  h1: "Catering enquiries land in your sheet",
  lead: "A new enquiry from Facebook is written into your sheet, and you hear about it straight away.",
  before: "Before",
  after: "After",
  facebook: "In Facebook",
  sheet: "Your sheet",
  alerts: "Owner alerts",
  happened: "What happened",
  sideBySide: "Before and after",
  triageTitle: "What we checked",
  foundTitle: "What we found",
  fixedTitle: "What we fixed first",
  laterTitle: "Flagged for later",
  nothingFound: "Nothing out of place.",
  fixedMissing: "Missing leads first, because a missed lead is a lost customer.",
  fixedDuplicates: "Duplicates next, so the same person is one row in your sheet.",
  fixedTurnedAway: "A request that is not from Facebook is turned away, and nothing is written.",
  none: "No leads yet.",
  sheetEmpty: "No rows yet.",
  alertsEmpty: "No alerts yet.",
  happenedEmpty: "Nothing has happened yet.",
  arrived: "Arrived in your sheet",
  sentAgain: "Sent again, arrived",
  duplicateStopped: "Duplicate stopped",
  turnedAway: "Turned away, not from Facebook",
  ownerAlerted: "Owner alerted",
  copied: "Copied into your sheet",
  copiedTwice: "Copied twice",
  notInSheet: "Not in your sheet",
  notCopied: "Not copied",
  priorLine: "From before switch-on, not copied (flagged for later)",
  alertHeading: "New catering enquiry",
  columns: ["Date", "Name", "Phone", "Email", "What they want", "Source form", "Status"] as const,
  nav: [
    { href: "/", label: "Leads" },
    { href: "/sheet", label: "Your sheet" },
    { href: "/alerts", label: "Owner alerts" },
    { href: "/happened", label: "What happened" },
    { href: "/before-after", label: "Before and after" },
    { href: "/before-after?view=triage", label: "What we checked" },
  ],
} as const;

export function countPhrase(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
