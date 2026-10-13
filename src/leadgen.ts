import type { GraphLead } from "./graph.ts";
import { normaliseAuPhone } from "./phone.ts";

/** One leadgen change, as Facebook posts it on a page subscription. */
export type LeadgenNotice = {
  leadgenId: string;
  formId: string;
  pageId: string;
  adId: string;
  createdUnix: number | null;
};

export type TidiedLead = {
  leadgenId: string;
  name: string;
  phone: string;
  phoneRaw: string;
  email: string;
  want: string;
  formName: string;
  createdTime: string;
};

const CONTACT_FIELDS = new Set([
  "full_name",
  "first_name",
  "last_name",
  "email",
  "phone_number",
  "city",
  "state",
  "province",
  "zip",
  "post_code",
  "country",
  "company_name",
  "job_title",
  "street_address",
  "date_of_birth",
]);

function asId(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * Read leadgen change notifications. Other fields are ignored.
 * The notice carries ids only. The person's answers come from the lead lookup.
 */
export function readLeadgenNotices(body: unknown): LeadgenNotice[] {
  if (!body || typeof body !== "object") return [];
  const root = body as Record<string, unknown>;
  if (root.object !== "page" || !Array.isArray(root.entry)) return [];
  const notices: LeadgenNotice[] = [];
  for (const entry of root.entry) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (!Array.isArray(item.changes)) continue;
    for (const change of item.changes) {
      if (!change || typeof change !== "object") continue;
      const row = change as Record<string, unknown>;
      if (row.field !== "leadgen" || !row.value || typeof row.value !== "object") continue;
      const value = row.value as Record<string, unknown>;
      const leadgenId = asId(value.leadgen_id);
      if (!leadgenId) continue;
      const created = value.created_time;
      notices.push({
        leadgenId,
        formId: asId(value.form_id),
        pageId: asId(value.page_id) || asId(item.id),
        adId: asId(value.ad_id),
        createdUnix: typeof created === "number" && Number.isFinite(created) ? created : null,
      });
    }
  }
  return notices;
}

/** Meta's lead created_time, either unix seconds or an offset timestamp. */
export function parseMetaTime(value: string | number): string | null {
  if (typeof value === "number") {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const normalised = value.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const date = new Date(normalised);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function metaTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "+0000");
}

/**
 * Turn Graph field_data into the sheet fields.
 * Name, a real email, an Australian phone and at least one answer are required.
 */
export function tidyLead(graph: GraphLead, formName: string): TidiedLead | null {
  const fields = new Map<string, string>();
  if (!Array.isArray(graph.field_data)) return null;
  for (const field of graph.field_data) {
    if (!field || typeof field.name !== "string" || !Array.isArray(field.values)) continue;
    const value = field.values
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0)
      .join(", ");
    if (value) fields.set(field.name, value);
  }
  const combined = [fields.get("first_name"), fields.get("last_name")].filter(Boolean).join(" ");
  const name = (fields.get("full_name") ?? combined).replace(/\s+/g, " ").trim();
  if (!name || name.length > 80 || !/\p{L}/u.test(name)) return null;
  const email = (fields.get("email") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return null;
  const phoneRaw = fields.get("phone_number") ?? "";
  const phone = normaliseAuPhone(phoneRaw);
  if (!phone) return null;
  const wants: string[] = [];
  for (const [key, value] of fields) {
    if (!CONTACT_FIELDS.has(key)) wants.push(value);
  }
  const want = wants.join("; ").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!want) return null;
  const createdTime = parseMetaTime(graph.created_time);
  if (!createdTime) return null;
  const form = formName.replace(/\s+/g, " ").trim();
  if (!form || form.length > 80) return null;
  if (!graph.id) return null;
  return {
    leadgenId: graph.id,
    name,
    phone,
    phoneRaw,
    email,
    want,
    formName: form,
    createdTime,
  };
}

export function leadgenBody(notice: LeadgenNotice): string {
  return JSON.stringify({
    object: "page",
    entry: [
      {
        id: notice.pageId,
        time: notice.createdUnix ?? 0,
        changes: [
          {
            field: "leadgen",
            value: {
              ad_id: notice.adId,
              form_id: notice.formId,
              leadgen_id: notice.leadgenId,
              created_time: notice.createdUnix ?? 0,
              page_id: notice.pageId,
              adgroup_id: notice.adId,
            },
          },
        ],
      },
    ],
  });
}
