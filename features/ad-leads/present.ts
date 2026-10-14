import { countPhrase, STORY } from "./story.ts";
import type { Attempt, FacebookLead, Picture, SheetRow } from "./store.ts";

export type Chip = {
  text: string;
};

export type PersonLine = {
  name: string;
  want: string;
  chips: Chip[];
};

export type SheetLine = {
  date: string;
  name: string;
  phone: string;
  email: string;
  want: string;
  formName: string;
  status: string;
  chips: Chip[];
};

export type PriorLine = {
  name: string;
  text: string;
};

export type ColumnView = {
  headline: string;
  facebook: PersonLine[];
  prior: PriorLine[];
  sheet: SheetLine[];
  notes: string[];
};

export type TriageFinding = {
  summary: string;
  lines: string[];
};

export type TriageView = {
  checked: string;
  found: TriageFinding[];
  fixed: string[];
  later: string[];
};

export function humanDate(iso: string): string {
  const formatted = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
  return formatted.replace(/\u202f/g, " ").replace(/\u00a0/g, " ");
}

function sheetCount(picture: Picture, leadgenId: string): number {
  return picture.sheetRows.filter((row) => row.leadgenId === leadgenId).length;
}

function attemptsFor(picture: Picture, leadgenId: string): Attempt[] {
  return picture.attempts.filter((row) => row.leadgenId === leadgenId);
}

function nameFor(picture: Picture, leadgenId: string): string {
  return (
    picture.facebookLeads.find((row) => row.leadgenId === leadgenId)?.name ??
    picture.sheetRows.find((row) => row.leadgenId === leadgenId)?.name ??
    ""
  );
}

function chipsFor(picture: Picture, lead: FacebookLead): Chip[] {
  const rows = sheetCount(picture, lead.leadgenId);
  const attempts = attemptsFor(picture, lead.leadgenId);
  const alerted = picture.alerts.some((row) => row.leadgenId === lead.leadgenId);
  const down = attempts.some((row) => row.outcome === "down");
  const duplicate = attempts.some((row) => row.outcome === "duplicate");
  const chips: Chip[] = [];
  if (rows >= 2) chips.push({ text: STORY.copiedTwice });
  else if (rows === 1 && down) chips.push({ text: STORY.sentAgain });
  else if (rows === 1 && alerted) chips.push({ text: STORY.arrived });
  else if (rows === 1) chips.push({ text: STORY.copied });
  else if (lead.prior) chips.push({ text: STORY.notCopied });
  else chips.push({ text: STORY.notInSheet });
  if (alerted) chips.push({ text: STORY.ownerAlerted });
  if (duplicate) chips.push({ text: STORY.duplicateStopped });
  return chips;
}

function sheetChips(picture: Picture, row: SheetRow): Chip[] {
  const lead = picture.facebookLeads.find((item) => item.leadgenId === row.leadgenId);
  if (!lead) return [];
  return chipsFor(picture, lead).filter((chip) => chip.text !== STORY.notCopied && chip.text !== STORY.notInSheet);
}

/** New leads since switch-on, against how many of those people are in the sheet. */
export function leadHeadline(picture: Picture): string {
  const current = picture.facebookLeads.filter((lead) => !lead.prior);
  const rowsOf = (id: string) => sheetCount(picture, id);
  const inSheet = current.filter((lead) => rowsOf(lead.leadgenId) >= 1).length;
  const faults: string[] = [];
  const twice = current.filter((lead) => rowsOf(lead.leadgenId) >= 2).length;
  const missing = current.filter((lead) => rowsOf(lead.leadgenId) === 0).length;
  if (twice > 0) faults.push(countPhrase(twice, "copied twice", "copied twice"));
  if (missing > 0) faults.push(countPhrase(missing, "missing", "missing"));
  const extra = faults.length > 0 ? ` (${faults.join(", ")})` : "";
  return `New leads: ${current.length}. In your sheet: ${inSheet}${extra}`;
}

export const EMPTY_HEADLINE = "New leads: 0. In your sheet: 0";

/** Customer pages show a mask. The stored address stays in the data file. */
export function maskEmail(email: string): string {
  const first = email.trim().charAt(0).toLowerCase();
  if (!first) return "email on file";
  return `${first}•••@••••`;
}

export function present(picture: Picture): ColumnView {
  const notes = picture.attempts
    .filter((row) => row.outcome === "rejected")
    .map(() => STORY.turnedAway);
  const current = picture.facebookLeads.filter((lead) => !lead.prior);
  return {
    headline: leadHeadline(picture),
    facebook: current.map((lead) => ({
      name: lead.name,
      want: lead.want,
      chips: chipsFor(picture, lead),
    })),
    prior: picture.facebookLeads
      .filter((lead) => lead.prior && sheetCount(picture, lead.leadgenId) === 0)
      .map((lead) => ({ name: lead.name, text: STORY.priorLine })),
    sheet: picture.sheetRows.map((row) => ({
      date: humanDate(row.createdTime),
      name: row.name,
      phone: row.phone,
      email: maskEmail(row.email),
      want: row.want,
      formName: row.formName,
      status: row.status,
      chips: sheetChips(picture, row),
    })),
    notes,
  };
}

function leadLine(lead: FacebookLead): string {
  return `${lead.name}, ${lead.want}`;
}

/** Plain triage of one stored run. Every count and name is read from that run. */
export function triageFrom(picture: Picture | null): TriageView {
  if (!picture) {
    return { checked: EMPTY_HEADLINE, found: [], fixed: [], later: [] };
  }
  const current = picture.facebookLeads.filter((lead) => !lead.prior);
  const older = picture.facebookLeads.filter((lead) => lead.prior);
  const missing = current.filter((lead) => sheetCount(picture, lead.leadgenId) === 0);
  const duplicated = current.filter((lead) => sheetCount(picture, lead.leadgenId) >= 2);
  const slowIds = [
    ...new Set(picture.attempts.filter((row) => row.outcome === "down").map((row) => row.leadgenId)),
  ];
  const turned = picture.attempts.filter((row) => row.outcome === "rejected").length;
  const found: TriageFinding[] = [];
  if (missing.length > 0) {
    found.push({
      summary: countPhrase(missing.length, "missing from your sheet", "missing from your sheet"),
      lines: missing.map(leadLine),
    });
  }
  if (duplicated.length > 0) {
    found.push({
      summary: countPhrase(duplicated.length, "copied twice", "copied twice"),
      lines: duplicated.map(leadLine),
    });
  }
  if (slowIds.length > 0) {
    found.push({
      summary: countPhrase(slowIds.length, "slow to arrive", "slow to arrive"),
      lines: slowIds.map((id) => {
        const lead = picture.facebookLeads.find((row) => row.leadgenId === id);
        return lead ? leadLine(lead) : nameFor(picture, id);
      }).filter((line) => line.length > 0),
    });
  }
  if (turned > 0) {
    found.push({
      summary: countPhrase(turned, "turned away, not from Facebook", "turned away, not from Facebook"),
      lines: [],
    });
  }
  const fixed: string[] = [];
  if (missing.length > 0) fixed.push(STORY.fixedMissing);
  if (duplicated.length > 0) fixed.push(STORY.fixedDuplicates);
  if (turned > 0) fixed.push(STORY.fixedTurnedAway);
  const later = older
    .filter((lead) => sheetCount(picture, lead.leadgenId) === 0)
    .map(
      (lead) =>
        `${lead.name}, ${lead.want}, ${humanDate(lead.createdTime)}, was already in Facebook before the switch-on and was not copied.`,
    );
  return {
    checked: leadHeadline(picture),
    found,
    fixed,
    later,
  };
}

export function historyLines(picture: Picture): string[] {
  const lines: { at: string; text: string }[] = [];
  const seen = new Set<string>();
  const ordered = [...picture.attempts].sort((a, b) => a.at.localeCompare(b.at));
  for (const attempt of ordered) {
    if (attempt.outcome === "rejected") {
      lines.push({ at: attempt.at, text: `${STORY.turnedAway}.` });
      continue;
    }
    if (attempt.outcome === "unusable" || attempt.outcome === "down") continue;
    if (seen.has(attempt.leadgenId) && attempt.outcome === "ok") continue;
    const name = nameFor(picture, attempt.leadgenId);
    if (!name) continue;
    if (attempt.outcome === "duplicate") {
      lines.push({ at: attempt.at, text: `${name}. ${STORY.duplicateStopped}.` });
      continue;
    }
    seen.add(attempt.leadgenId);
    const attempts = attemptsFor(picture, attempt.leadgenId);
    const down = attempts.some((row) => row.outcome === "down");
    const alerted = picture.alerts.some((row) => row.leadgenId === attempt.leadgenId);
    if (down && alerted) {
      lines.push({ at: attempt.at, text: `${name}. ${STORY.sentAgain}. ${STORY.ownerAlerted}.` });
    } else if (alerted) {
      lines.push({ at: attempt.at, text: `${name}. ${STORY.arrived}. ${STORY.ownerAlerted}.` });
    } else if (sheetCount(picture, attempt.leadgenId) >= 2) {
      lines.push({ at: attempt.at, text: `${name}. ${STORY.copiedTwice}.` });
    } else if (sheetCount(picture, attempt.leadgenId) === 1) {
      lines.push({ at: attempt.at, text: `${name}. ${STORY.copied}.` });
    }
  }
  lines.sort((a, b) => a.at.localeCompare(b.at));
  return lines.map((row) => row.text);
}
