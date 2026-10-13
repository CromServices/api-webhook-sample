import type { GraphLead } from "./graph.ts";
import { metaTime } from "./leadgen.ts";

export const FORM_NAME = "Catering enquiry";
export const FORM_ID = "2002002002002";
export const PAGE_ID = "3003003003003";
export const AD_ID = "4004004004004";
export const FORGED_ID = "9009009009009";

export type Person = {
  leadgenId: string;
  name: string;
  email: string;
  phoneRaw: string;
  want: string;
};

/** Fictional catering enquiries. The same four faults are used in both runs. */
export const PEOPLE = {
  jordan: {
    leadgenId: "1001001001001",
    name: "Jordan Hale",
    email: "jordan.example@example.com",
    phoneRaw: "+61 400 000 101",
    want: "Morning tea for 12",
  },
  riley: {
    leadgenId: "1001001001002",
    name: "Riley Tran",
    email: "riley.example@example.com",
    phoneRaw: "0400000202",
    want: "Lunch for 20",
  },
  casey: {
    leadgenId: "1001001001003",
    name: "Casey Moore",
    email: "casey.example@example.com",
    phoneRaw: "61 400 000 303",
    want: "Wedding morning tea",
  },
  avery: {
    leadgenId: "1001001001004",
    name: "Avery Singh",
    email: "avery.example@example.com",
    phoneRaw: "(04) 0000 0404",
    want: "Office lunch for 8",
  },
} as const satisfies Record<string, Person>;

type StateShape = {
  copyPhase: "idle" | "snapshotted" | "done";
  facebookLeads: { leadgenId: string }[];
  sheetRows: { leadgenId: string }[];
  alerts: { leadgenId: string }[];
};

async function admin(base: string, token: string, route: string, body?: unknown, method = "POST") {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${route} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

function graphLead(person: Person, created: Date): GraphLead {
  return {
    created_time: metaTime(created),
    id: person.leadgenId,
    ad_id: AD_ID,
    form_id: FORM_ID,
    field_data: [
      { name: "full_name", values: [person.name] },
      { name: "email", values: [person.email] },
      { name: "phone_number", values: [person.phoneRaw] },
      { name: "what_do_you_need", values: [person.want] },
    ],
  };
}

async function register(base: string, token: string, person: Person, created: Date): Promise<void> {
  await admin(base, token, "/admin/graph", {
    lead: graphLead(person, created),
    formName: FORM_NAME,
    pageId: PAGE_ID,
    adId: AD_ID,
    createdUnix: Math.floor(created.getTime() / 1000),
  });
}

async function stateOf(base: string, token: string): Promise<StateShape> {
  const res = await fetch(`${base}/admin/state`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("state unavailable");
  return (await res.json()) as StateShape;
}

async function waitFor(read: () => Promise<boolean>, ms = 4000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await read()) return;
    if (Date.now() - start > ms) throw new Error("timed out waiting for the run");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function oneRun(base: string, token: string, mode: "old" | "fixed"): Promise<void> {
  if (mode === "old") await admin(base, token, "/admin/mode", { mode: "old" });
  await admin(base, token, "/admin/seed-old", { leadgenId: PEOPLE.avery.leadgenId });
  await admin(base, token, "/admin/deliver", { leadgenId: PEOPLE.jordan.leadgenId });
  await admin(base, token, "/admin/deliver", { leadgenId: PEOPLE.riley.leadgenId });
  await admin(base, token, "/admin/deliver", { leadgenId: PEOPLE.riley.leadgenId });
  await admin(base, token, "/admin/fail-once", { leadgenId: PEOPLE.casey.leadgenId });
  if (mode === "old") {
    const copying = admin(base, token, "/admin/copy");
    await waitFor(async () => (await stateOf(base, token)).copyPhase === "snapshotted");
    await admin(base, token, "/admin/deliver", { leadgenId: PEOPLE.casey.leadgenId });
    await copying;
  } else {
    await admin(base, token, "/admin/deliver", { leadgenId: PEOPLE.casey.leadgenId });
  }
  await admin(base, token, "/admin/forge", {
    leadgenId: FORGED_ID,
    formId: FORM_ID,
    pageId: PAGE_ID,
  });
  await admin(base, token, "/admin/snapshot", { name: mode === "old" ? "before" : "after" });
}

/**
 * One old-way run, then the same leads and the same faults on the fixed way.
 * Everything lands through the lead intake. Nothing here is painted on afterwards.
 */
export async function runBoth(base: string, token: string): Promise<void> {
  const now = new Date();
  const earlier = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
  await register(base, token, PEOPLE.avery, earlier);
  await register(base, token, PEOPLE.jordan, now);
  await register(base, token, PEOPLE.riley, now);
  await register(base, token, PEOPLE.casey, now);
  await oneRun(base, token, "old");
  await admin(base, token, "/admin/reset", { mode: "fixed" });
  await oneRun(base, token, "fixed");
}
