import { CROM_FOOTER, CROM_HEADER, THEME_CSS_URL } from "../landing.ts";
import { OWNER_NAME, SHOP_NAME } from "./flow.ts";
import type { CallLogEntry } from "./calllog.ts";

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 0491570006 -> "0491 570 006"; 0855501234 -> "(08) 5550 1234". */
export function showPhone(value: string): string {
  if (/^04\d{8}$/.test(value)) return `${value.slice(0, 4)} ${value.slice(4, 7)} ${value.slice(7)}`;
  if (/^0[2378]\d{8}$/.test(value)) return `(${value.slice(0, 2)}) ${value.slice(2, 6)} ${value.slice(6)}`;
  return value ? "Number given" : "Number hidden";
}

function when(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(new Date(iso))
    .replace(/\s?(am|pm)$/i, (m) => m.toLowerCase())
    .replace(",", "");
}

function length(entry: CallLogEntry): string {
  const secs = Math.max(0, Math.round((Date.parse(entry.endedAt) - Date.parse(entry.startedAt)) / 1000));
  if (secs < 60) return `${secs} sec`;
  const mins = Math.floor(secs / 60);
  const rest = secs % 60;
  return rest ? `${mins} min ${rest} sec` : `${mins} min`;
}

function sentence(list: string[]): string {
  if (list.length === 0) return "";
  const words = list.map((item, i) =>
    i === 0 || item.startsWith(OWNER_NAME) ? item : item.charAt(0).toLowerCase() + item.slice(1),
  );
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(", ")}, then ${words.at(-1)!}`;
}

function passed(entry: CallLogEntry): string {
  if (!entry.handedOver) return "No";
  if (entry.ownerAnswered) return `Yes, ${OWNER_NAME} picked up`;
  if (entry.textedOwner && entry.message) return `Yes, no answer, so a message was taken and ${OWNER_NAME} got a text`;
  if (entry.textedOwner) return `Yes, no answer, so ${OWNER_NAME} got a text`;
  return `Yes, no answer`;
}

function row(label: string, value: string): string {
  return `<div style="display:grid;grid-template-columns:minmax(110px,30%) 1fr;gap:12px;padding:6px 0;border-top:1px solid var(--border);"><div class="crom-note" style="margin:0;">${esc(label)}</div><div style="font-weight:500;">${esc(value)}</div></div>`;
}

function card(entry: CallLogEntry, timeZone: string): string {
  const chip = entry.handedOver ? `Passed to ${OWNER_NAME}` : "Answered";
  const rows = [
    row("Caller", showPhone(entry.caller)),
    row("Caller asked", sentence(entry.asked)),
    row("Told", sentence(entry.told) || "Nothing yet, the caller hung up"),
    row(`Passed to ${OWNER_NAME}`, passed(entry)),
  ];
  if (entry.message) rows.push(row("Message", `"${entry.message}"`));
  return `<section style="border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-top:12px;">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:6px;">
    <h2 class="crom-h3" style="margin:0;">${esc(when(entry.startedAt, timeZone))}</h2>
    <span class="crom-chip">${esc(chip)}</span>
  </div>
  <p class="crom-note" style="margin:0 0 4px;">Call length ${esc(length(entry))}</p>
  ${rows.join("")}
</section>`;
}

export function callLogPage(entries: CallLogEntry[], timeZone = "Australia/Sydney"): string {
  const passedCount = entries.filter((e) => e.handedOver).length;
  const body = entries.length
    ? entries.map((e) => card(e, timeZone)).join("")
    : `<p class="crom-note" style="margin-top:16px;">No calls yet.</p>`;
  const totals = entries.length
    ? `<p style="font-weight:600;margin:12px 0 0;">${entries.length} ${entries.length === 1 ? "call" : "calls"}. ${passedCount} passed to ${OWNER_NAME}.</p>`
    : "";
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(SHOP_NAME)} · calls</title>
<link rel="stylesheet" href="${THEME_CSS_URL}">
</head>
<body>
${CROM_HEADER}
<main class="crom-shell">
<section style="padding:0;">
  <p class="crom-eyebrow">${esc(SHOP_NAME)} · phone line</p>
  <h1 class="crom-h1">Calls</h1>
  <p class="crom-lead" style="margin-top:8px;">Every call to the shop's line, newest first. Only you can see this page.</p>
  ${totals}
  ${body}
</section>
${CROM_FOOTER}
</main>
</body>
</html>`;
}
