import { CROM_FOOTER, CROM_HEADER, THEME_CSS_URL } from "../../shared/landing.ts";
import {
  EMPTY_HEADLINE,
  historyLines,
  humanDate,
  maskEmail,
  present,
  triageFrom,
  type ColumnView,
  type PersonLine,
  type SheetLine,
  type TriageView,
} from "./present.ts";
import { STORY } from "./story.ts";
import type { Picture, Snapshot } from "./store.ts";

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function chips(list: { text: string }[]): string {
  if (list.length === 0) return "";
  return `<span style="display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;">${list
    .map((chip) => `<span class="crom-chip">${esc(chip.text)}</span>`)
    .join("")}</span>`;
}

/** Pills sit on their own line. Each pill stays one line, with room between them. */
function pillsBelow(list: { text: string }[]): string {
  if (list.length === 0) return "";
  return `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;">${list
    .map(
      (chip) =>
        `<span class="crom-chip" style="white-space:nowrap;flex-shrink:0;padding:5px 14px;">${esc(chip.text)}</span>`,
    )
    .join("")}</div>`;
}

function nav(): string {
  return `<p style="display:flex;flex-wrap:wrap;gap:14px;margin:8px 0 0;">${STORY.nav
    .map((item) => `<a href="${item.href}">${esc(item.label)}</a>`)
    .join("")}</p>`;
}

const COMPARE_WIDTH = "1560px";

function shell(body: string, wide = false): string {
  const header = wide
    ? CROM_HEADER.replace(
        '<div class="crom-header__inner">',
        `<div class="crom-header__inner" style="max-width:${COMPARE_WIDTH}">`,
      )
    : CROM_HEADER;
  const main = wide
    ? `<main class="crom-shell" style="max-width:${COMPARE_WIDTH}">`
    : '<main class="crom-shell">';
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(STORY.pageTitle)}</title>
<link rel="stylesheet" href="${THEME_CSS_URL}">
</head>
<body>
${header}
${main}
${body}
${CROM_FOOTER}
</main>
</body>
</html>`;
}

function intro(title: string): string {
  return `<section style="padding:8px 0 0;">
    <p class="crom-eyebrow">${esc(STORY.shopName)}</p>
    <h1 class="crom-h2">${esc(title)}</h1>
    ${nav()}
  </section>`;
}

function person(line: PersonLine, compact: boolean): string {
  if (compact) {
    return `<div style="padding:6px 0 2px;border-top:1px solid var(--border);">
      <div style="white-space:nowrap;font-size:15px;line-height:1.35;"><strong>${esc(line.name)}</strong> <span class="crom-note">${esc(line.want)}</span></div>
      ${pillsBelow(line.chips)}
    </div>`;
  }
  return `<div style="padding:3px 0;border-top:1px solid var(--border);font-size:14px;">
    <div style="display:flex;justify-content:space-between;gap:6px;align-items:center;">
      <strong>${esc(line.name)}</strong>
      ${chips(line.chips)}
    </div>
    <span class="crom-note">${esc(line.want)}</span>
  </div>`;
}

function sheetSummary(line: SheetLine, compact: boolean): string {
  if (compact) {
    return `<div style="padding:6px 0 2px;border-top:1px solid var(--border);">
      <div style="white-space:nowrap;font-size:15px;line-height:1.35;"><strong>${esc(line.date)} · ${esc(line.name)}</strong> <span class="crom-note">${esc(line.want)} · ${esc(line.status)}</span></div>
      ${pillsBelow(line.chips)}
    </div>`;
  }
  return `<div style="padding:3px 0;border-top:1px solid var(--border);font-size:14px;">
    <div style="display:flex;justify-content:space-between;gap:6px;align-items:center;">
      <strong>${esc(line.date)} · ${esc(line.name)}</strong>
      ${chips(line.chips)}
    </div>
    <span class="crom-note">${esc(line.phone)} · ${esc(line.want)} · ${esc(line.status)}</span>
  </div>`;
}

function priorLines(view: ColumnView): string {
  return view.prior
    .map(
      (line) =>
        `<p style="margin:4px 0 0;font-size:13px;line-height:1.3;">${esc(line.name)}. ${esc(line.text)}</p>`,
    )
    .join("");
}

function column(title: string, view: ColumnView, stacked = false): string {
  const facebook =
    view.facebook.length === 0
      ? `<p class="crom-note" style="margin:8px 0 0;">${esc(STORY.none)}</p>`
      : view.facebook.map((line) => person(line, stacked)).join("");
  const sheet =
    view.sheet.length === 0
      ? `<p class="crom-note" style="margin:8px 0 0;">${esc(STORY.sheetEmpty)}</p>`
      : view.sheet.map((line) => sheetSummary(line, stacked)).join("");
  const notes = view.notes
    .map(
      (line) =>
        `<p style="margin:8px 0 0;">${
          stacked
            ? `<span class="crom-chip" style="white-space:nowrap;flex-shrink:0;padding:5px 14px;">${esc(line)}</span>`
            : `<span class="crom-chip">${esc(line)}</span>`
        }</p>`,
    )
    .join("");
  const lists = stacked
    ? `<div style="margin-top:6px;">
        <h3 class="crom-h3">${esc(STORY.facebook)}</h3>
        ${facebook}
        ${priorLines(view)}
        <h3 class="crom-h3" style="margin-top:8px;">${esc(STORY.sheet)}</h3>
        ${sheet}
      </div>`
    : `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;margin-top:6px;">
        <div>
          <h3 class="crom-h3">${esc(STORY.facebook)}</h3>
          ${facebook}
        </div>
        <div>
          <h3 class="crom-h3">${esc(STORY.sheet)}</h3>
          ${sheet}
        </div>
      </div>
      ${priorLines(view)}`;
  const pad = stacked ? "10px 18px" : "8px 12px";
  return `<section style="border:1px solid var(--border);border-radius:12px;padding:${pad};">
    <h2 class="crom-h3">${esc(title)}</h2>
    <p style="font-weight:600;margin:2px 0 0;font-size:14px;line-height:1.3;">${esc(view.headline)}</p>
    ${lists}
    ${notes}
  </section>`;
}

export function homePage(picture: Picture): string {
  const view = present(picture);
  return shell(`${intro(STORY.h1)}
  <p class="crom-lead" style="margin-top:8px;">${esc(STORY.lead)}</p>
  <div style="margin-top:12px;">${column(STORY.shopName, view)}</div>`);
}

export function sheetPage(picture: Picture): string {
  const rows =
    picture.sheetRows.length === 0
      ? `<p class="crom-note" style="margin:12px 0 0;">${esc(STORY.sheetEmpty)}</p>`
      : `<table style="width:100%;border-collapse:collapse;margin-top:12px;font-size:14px;">
      <thead>
        <tr>${STORY.columns
          .map(
            (name) =>
              `<th style="text-align:left;padding:8px;border:1px solid var(--border);background:var(--soft);font-weight:600;">${esc(name)}</th>`,
          )
          .join("")}</tr>
      </thead>
      <tbody>
        ${picture.sheetRows
          .map((row) => {
            const cells = [
              humanDate(row.createdTime),
              row.name,
              row.phone,
              maskEmail(row.email),
              row.want,
              row.formName,
              row.status,
            ];
            return `<tr>${cells
              .map(
                (cell) =>
                  `<td style="padding:8px;border:1px solid var(--border);vertical-align:top;">${esc(cell)}</td>`,
              )
              .join("")}</tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
  return shell(`${intro(STORY.sheet)}
  <section class="crom-card" style="margin-top:12px;padding:12px;">
    <p style="font-weight:600;margin:0;">${esc(present(picture).headline)}</p>
    ${rows}
  </section>`);
}

export function alertsPage(picture: Picture): string {
  const cards =
    picture.alerts.length === 0
      ? `<p class="crom-note" style="margin:12px 0 0;">${esc(STORY.alertsEmpty)}</p>`
      : `<div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:12px;">${picture.alerts
          .map(
            (alert) => `<article style="width:320px;border:1px solid var(--border);border-radius:16px;background:var(--card);padding:14px;">
        <p class="crom-eyebrow" style="margin:0;">${esc(STORY.shopName)}</p>
        <p style="font-weight:600;margin:8px 0 0;">${esc(STORY.alertHeading)}</p>
        <p style="margin:8px 0 0;">${esc(alert.name)}</p>
        <p style="margin:2px 0 0;">${esc(alert.phone)}</p>
        <p class="crom-note" style="margin:2px 0 0;">${esc(alert.want)}</p>
        <p style="margin:10px 0 0;"><span class="crom-chip">${esc(STORY.ownerAlerted)}</span></p>
      </article>`,
          )
          .join("")}</div>`;
  return shell(`${intro(STORY.alerts)}
  <section style="margin-top:4px;">${cards}</section>`);
}

export function happenedPage(picture: Picture): string {
  const lines = historyLines(picture);
  const body =
    lines.length === 0
      ? `<p class="crom-note" style="margin:12px 0 0;">${esc(STORY.happenedEmpty)}</p>`
      : lines
          .map(
            (line) =>
              `<p style="margin:10px 0 0;padding-top:10px;border-top:1px solid var(--border);">${esc(line)}</p>`,
          )
          .join("");
  return shell(`${intro(STORY.happened)}
  <section class="crom-card" style="margin-top:12px;padding:12px 16px;">${body}</section>`);
}

function shot(snapshot: Snapshot | null): ColumnView {
  if (!snapshot) {
    return { headline: EMPTY_HEADLINE, facebook: [], prior: [], sheet: [], notes: [] };
  }
  return present(snapshot);
}

function triageBlock(title: string, body: string): string {
  return `<section style="margin-top:12px;"><h2 class="crom-h3">${esc(title)}</h2>${body}</section>`;
}

function triageBody(view: TriageView): string {
  const found =
    view.found.length === 0
      ? `<p style="margin:8px 0 0;">${esc(STORY.nothingFound)}</p>`
      : view.found
          .map((item) => {
            const lines = item.lines
              .map((line) => `<p class="crom-note" style="margin:4px 0 0;">${esc(line)}</p>`)
              .join("");
            return `<p style="margin:10px 0 0;font-weight:600;">${esc(item.summary)}</p>${lines}`;
          })
          .join("");
  const fixed =
    view.fixed.length === 0
      ? ""
      : triageBlock(
          STORY.fixedTitle,
          view.fixed.map((line, index) => `<p style="margin:8px 0 0;">${index + 1}. ${esc(line)}</p>`).join(""),
        );
  const later =
    view.later.length === 0
      ? ""
      : triageBlock(
          STORY.laterTitle,
          view.later.map((line) => `<p style="margin:8px 0 0;">${esc(line)}</p>`).join(""),
        );
  return `<p style="margin:0;font-weight:600;">${esc(view.checked)}</p>
    ${triageBlock(STORY.foundTitle, found)}
    ${fixed}
    ${later}`;
}

export function comparePage(before: Snapshot | null, after: Snapshot | null, view: "side" | "triage"): string {
  if (view === "triage") {
    return shell(`${intro(STORY.triageTitle)}
  <section class="crom-card" style="margin-top:12px;padding:16px;">
    ${triageBody(triageFrom(before))}
  </section>`);
  }
  return shell(
    `${intro(STORY.sideBySide)}
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:8px;">
    ${column(STORY.before, shot(before), true)}
    ${column(STORY.after, shot(after), true)}
  </div>`,
    true,
  );
}
