/** Summary email for one support message. Sent through Resend (demo.cromservices.com.au, already verified). */
export type SupportMessage = {
  ref: string;
  startedAt: string;
  callerId: string;
  name: string;
  contactHeard: string;
  contact: { kind: "email" | "phone"; value: string } | null;
  reference: string;
  referenceConfirmed: boolean;
  /** What the speech side heard for the reference, each try. */
  referenceHeard: string[];
  issueText: string;
  recordingSeconds: number | null;
  /** True when the caller hung up before the end. */
  partial: boolean;
};

export type Attachment = { filename: string; content: string };
export type MailSender = (m: { subject: string; text: string; html: string; replyTo?: string; attachments?: Attachment[] }) => Promise<{ ok: boolean; id?: string; error?: string }>;

export function resendSender(opts: { apiKey: string; from: string; to: string; fetchImpl?: typeof fetch }): MailSender {
  const f = opts.fetchImpl ?? fetch;
  return async (m) => {
    const r = await f("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: opts.from,
        to: [opts.to],
        subject: m.subject,
        text: m.text,
        html: m.html,
        ...(m.replyTo ? { reply_to: m.replyTo } : {}),
        ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      }),
    });
    const body = (await r.json().catch(() => ({}))) as { id?: string; message?: string };
    return r.ok ? { ok: true, id: body.id } : { ok: false, error: `${r.status} ${body.message ?? ""}`.trim() };
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function summaryEmail(m: SupportMessage, timeZone: string) {
  const when = new Intl.DateTimeFormat("en-AU", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(m.startedAt));
  const zone = timeZone === "Australia/Perth" ? "AWST" : timeZone;
  const contact = m.contact ? m.contact.value : m.contactHeard ? `${m.contactHeard} (as heard, not understood as an email or number)` : "not given";
  const reference =
    m.reference === "none"
      ? "none (caller has no reference)"
      : m.reference
        ? `${m.reference} (${m.referenceConfirmed ? "read back and confirmed by the caller" : "not confirmed, check it"})`
        : "not given";
  const rows: [string, string][] = [
    ["Name", m.name || "not given"],
    ["Reply to", contact],
    ["Order or job reference", reference],
    ["Issue", m.issueText || (m.recordingSeconds ? "see the attached recording (no transcript)" : "not given")],
    ["Recording", m.recordingSeconds ? `${m.recordingSeconds} s, attached` : "none"],
    ["Caller ID", m.callerId || "withheld"],
    ["Called", `${when} ${zone}`],
    ["Promised", "a written reply within 1 business day"],
  ];
  if (m.partial) rows.push(["Note", "The caller hung up before the end, so some details may be missing."]);
  if (m.referenceHeard.length > 1) rows.push(["Reference tries", m.referenceHeard.join(" | ")]);
  const subject = `Support message: ${m.name || "caller"}${m.reference && m.reference !== "none" ? `, ref ${m.reference}` : ""}${m.partial ? " (partial)" : ""}`;
  const text = `New support message on the Crom Services line.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nCall ref: ${m.ref}\n`;
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1a1a1a"><p>New support message on the Crom Services line.</p>` +
    `<table cellpadding="6" style="border-collapse:collapse">${rows
      .map(([k, v]) => `<tr><td style="color:#555;vertical-align:top;white-space:nowrap"><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`)
      .join("")}</table><p style="color:#888;font-size:12px">Call ref: ${esc(m.ref)}</p></div>`;
  const replyTo = m.contact?.kind === "email" ? m.contact.value : undefined;
  return { subject, text, html, replyTo };
}
