import type { InboxRow } from "./routes.ts";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Show only the last 3 digits of a customer's number on the owner page. */
export function maskNumber(from: string): string {
  const d = from.replace(/\D/g, "");
  return d.length >= 3 ? `•••• ••• ${d.slice(-3)}` : "••••";
}

const REASON: Record<string, string> = {
  no_match: "Asked about an order we couldn't match",
  person: "Would like to chat with you",
  change: "Wants to change or raise a problem with an order",
};

export function inboxPage(rows: readonly InboxRow[], timeZone = "Australia/Perth"): string {
  const when = (t: number) =>
    new Intl.DateTimeFormat("en-AU", { timeZone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(t);
  const items = [...rows].reverse().map((r) =>
    r.kind === "lead"
      ? `<li class="lead"><b>New enquiry from ${esc(r.lead.name)}</b><p>${esc(r.lead.need)}</p><small>${when(r.at)} · ${maskNumber(r.lead.from)}</small></li>`
      : `<li class="hand"><b>${REASON[r.handoff.reason] ?? "Needs a reply"}</b><p>“${esc(r.handoff.text)}”</p><small>${when(r.at)} · ${maskNumber(r.handoff.from)}</small></li>`,
  );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sam's Café · WhatsApp messages</title><style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f3ee;color:#222}main{max-width:720px;margin:0 auto;padding:24px 16px}
h1{font-size:1.4rem;margin:0 0 4px}ul{list-style:none;padding:0}li{background:#fff;border-radius:12px;padding:14px 16px;margin:12px 0;border-left:6px solid #2a7d4f}
li.hand{border-left-color:#c77d16}p{margin:6px 0}small{color:#666}footer{color:#777;font-size:.85rem;margin-top:32px}
</style></head><body><main><h1>WhatsApp messages for Sam</h1><p>New enquiries and chats that need you. Order updates were sent straight away.</p>
${items.length ? `<ul>${items.join("")}</ul>` : "<p>Nothing waiting for you.</p>"}
<footer>Crom Services, Australia</footer></main></body></html>`;
}
