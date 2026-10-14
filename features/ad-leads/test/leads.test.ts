import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../app.ts";
import { createGraphStandIn } from "../graph.ts";
import { leadgenBody, metaTime, readLeadgenNotices, tidyLead } from "../leadgen.ts";
import { normaliseAuPhone } from "../phone.ts";
import { humanDate, leadHeadline } from "../present.ts";
import { STORY } from "../story.ts";
import { FORGED_ID, FORM_ID, FORM_NAME, PAGE_ID, PEOPLE, runBoth } from "../scenario.ts";
import type { State } from "../store.ts";
import { signBody } from "../../../shared/verify.ts";

const TOKEN = "test-admin-token";
const APP_SECRET = "test-meta-app-secret";
const VERIFY = "test-verify-token";

function readState(dataPath: string): State {
  return JSON.parse(readFileSync(dataPath, "utf8")) as State;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function visible(html: string): string {
  const body = html.slice(html.indexOf("<body"));
  return body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function boot(opts?: { window?: number; exportDelay?: number; retry?: number }) {
  const dataPath = path.join(mkdtempSync(path.join(tmpdir(), "crom-leads-")), "leads.json");
  let base = "";
  const app = createApp({
    webhookSecret: "test-webhook-secret",
    appSecret: APP_SECRET,
    verifyToken: VERIFY,
    adminToken: TOKEN,
    dataPath,
    duplicateWindowMs: opts?.window,
    exportDelayMs: opts?.exportDelay ?? 80,
    retryDelayMs: opts?.retry ?? 20,
    clientTimeoutMs: 2000,
    leadgenUrl: () => `${base}/leadgen`,
  });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
  return { server, base, dataPath };
}

async function admin(base: string, route: string, body?: unknown) {
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
  return res;
}

function personBody(
  person: { leadgenId: string; name: string; email: string; phoneRaw: string; want: string },
  created = new Date(),
) {
  return {
    lead: {
      created_time: metaTime(created),
      id: person.leadgenId,
      ad_id: "4004004004004",
      form_id: FORM_ID,
      field_data: [
        { name: "full_name", values: [person.name] },
        { name: "email", values: [person.email] },
        { name: "phone_number", values: [person.phoneRaw] },
        { name: "what_do_you_need", values: [person.want] },
      ],
    },
    formName: FORM_NAME,
    pageId: PAGE_ID,
    adId: "4004004004004",
    createdUnix: Math.floor(created.getTime() / 1000),
  };
}

describe("Australian phones", () => {
  it("normalises the forms people actually type", () => {
    assert.equal(normaliseAuPhone("+61 400 000 101"), "0400 000 101");
    assert.equal(normaliseAuPhone("+61400000101"), "0400 000 101");
    assert.equal(normaliseAuPhone("61400000101"), "0400 000 101");
    assert.equal(normaliseAuPhone("0400000101"), "0400 000 101");
    assert.equal(normaliseAuPhone("0400 000 101"), "0400 000 101");
    assert.equal(normaliseAuPhone("(04) 0000 0101"), "0400 000 101");
    assert.equal(normaliseAuPhone("04-0000-0101"), "0400 000 101");
    assert.equal(normaliseAuPhone("02 0000 0000"), "02 0000 0000");
    assert.equal(normaliseAuPhone("12345"), null);
    assert.equal(normaliseAuPhone("+1 400 000 0101"), null);
    assert.equal(normaliseAuPhone("0400 000 10"), null);
  });
});

describe("lead notice and tidy", () => {
  it("reads a leadgen change and ignores anything else", () => {
    const notices = readLeadgenNotices({
      object: "page",
      entry: [
        {
          id: PAGE_ID,
          time: 1,
          changes: [
            { field: "feed", value: { item: "post" } },
            {
              field: "leadgen",
              value: {
                ad_id: "4004004004004",
                form_id: FORM_ID,
                leadgen_id: PEOPLE.jordan.leadgenId,
                created_time: 1_700_000_000,
                page_id: PAGE_ID,
                adgroup_id: "4004004004004",
              },
            },
          ],
        },
      ],
    });
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.leadgenId, PEOPLE.jordan.leadgenId);
    assert.equal(notices[0]?.formId, FORM_ID);
    assert.deepEqual(readLeadgenNotices({ object: "user", entry: [] }), []);
  });

  it("tidies the lead lookup into a sheet row", () => {
    const lead = tidyLead(personBody(PEOPLE.jordan).lead, FORM_NAME);
    assert.ok(lead);
    assert.equal(lead?.phone, "0400 000 101");
    assert.equal(lead?.phoneRaw, "+61 400 000 101");
    assert.equal(lead?.email, "jordan.hale@example.com");
    assert.equal(lead?.want, "Morning tea for 12");
    assert.equal(tidyLead({ ...personBody(PEOPLE.jordan).lead, field_data: [] }, FORM_NAME), null);
  });
});

describe("handshake and signature", () => {
  let server: Server;
  let base = "";
  let dataPath = "";

  before(async () => {
    const started = await boot();
    server = started.server;
    base = started.base;
    dataPath = started.dataPath;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("answers the verify handshake with the challenge", async () => {
    const res = await fetch(
      `${base}/leadgen?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=918273645`,
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
    assert.equal(await res.text(), "918273645");
  });

  it("refuses a verify handshake with the wrong token", async () => {
    const res = await fetch(
      `${base}/leadgen?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=918273645`,
    );
    assert.equal(res.status, 403);
    assert.notEqual(await res.text(), "918273645");
  });

  it("accepts a signed leadgen notice and refuses a bad signature", async () => {
    assert.equal((await admin(base, "/admin/graph", personBody(PEOPLE.jordan))).status, 200);
    const raw = leadgenBody({
      leadgenId: PEOPLE.jordan.leadgenId,
      formId: FORM_ID,
      pageId: PAGE_ID,
      adId: "4004004004004",
      createdUnix: Math.floor(Date.now() / 1000),
    });
    const good = await fetch(`${base}/leadgen`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${signBody(APP_SECRET, raw)}`,
      },
      body: raw,
    });
    assert.equal(good.status, 200);
    const body = (await good.json()) as { received: boolean; duplicate: boolean };
    assert.equal(body.received, true);
    assert.equal(body.duplicate, false);
    const state = readState(dataPath);
    assert.equal(state.sheetRows.length, 1);
    assert.equal(state.sheetRows[0]?.phone, "0400 000 101");
    assert.equal(state.alerts.length, 1);

    const forged = await fetch(`${base}/leadgen`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${"ab".repeat(32)}`,
      },
      body: raw,
    });
    assert.equal(forged.status, 401);
    assert.equal(readState(dataPath).sheetRows.length, 1);
    assert.equal(readState(dataPath).facebookLeads.length, 1);
    assert.equal(readState(dataPath).alerts.length, 1);
  });

  it("fails closed when the app secret is empty", async () => {
    const closedPath = path.join(mkdtempSync(path.join(tmpdir(), "crom-leads-")), "leads.json");
    const closed = createApp({
      webhookSecret: "test-webhook-secret",
      appSecret: "",
      verifyToken: VERIFY,
      dataPath: closedPath,
    });
    const closedServer: Server = await new Promise((resolve) => {
      const listening = closed.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const addr = closedServer.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const raw = "{}";
    const res = await fetch(`http://127.0.0.1:${addr.port}/leadgen`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${signBody("anything", raw)}`,
      },
      body: raw,
    });
    assert.equal(res.status, 401);
    await new Promise<void>((resolve, reject) => {
      closedServer.close((err) => (err ? reject(err) : resolve()));
    });
  });
});

describe("fixed way", () => {
  let server: Server;
  let base = "";
  let dataPath = "";

  before(async () => {
    const started = await boot();
    server = started.server;
    base = started.base;
    dataPath = started.dataPath;
    assert.equal((await admin(base, "/admin/graph", personBody(PEOPLE.jordan))).status, 200);
    assert.equal((await admin(base, "/admin/graph", personBody(PEOPLE.riley))).status, 200);
    assert.equal((await admin(base, "/admin/graph", personBody(PEOPLE.casey))).status, 200);
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("blocks the same lead sent twice", async () => {
    assert.equal((await admin(base, "/admin/deliver", { leadgenId: PEOPLE.riley.leadgenId })).status, 200);
    assert.equal((await admin(base, "/admin/deliver", { leadgenId: PEOPLE.riley.leadgenId })).status, 200);
    const state = readState(dataPath);
    assert.equal(state.sheetRows.filter((row) => row.leadgenId === PEOPLE.riley.leadgenId).length, 1);
    assert.equal(state.alerts.filter((row) => row.leadgenId === PEOPLE.riley.leadgenId).length, 1);
    assert.equal(state.facebookLeads.filter((row) => row.leadgenId === PEOPLE.riley.leadgenId).length, 1);
    assert.equal(
      state.attempts.filter((row) => row.leadgenId === PEOPLE.riley.leadgenId && row.outcome === "duplicate")
        .length,
      1,
    );
  });

  it("blocks the same person again inside a short window", async () => {
    const other = {
      ...PEOPLE.jordan,
      leadgenId: "1001001001999",
      email: "other.jordan@example.com",
      phoneRaw: "0400 000 101",
      want: "Afternoon tea for 12",
    };
    assert.equal((await admin(base, "/admin/graph", personBody(PEOPLE.jordan))).status, 200);
    assert.equal((await admin(base, "/admin/graph", personBody(other))).status, 200);
    assert.equal((await admin(base, "/admin/deliver", { leadgenId: PEOPLE.jordan.leadgenId })).status, 200);
    assert.equal((await admin(base, "/admin/deliver", { leadgenId: other.leadgenId })).status, 200);
    const state = readState(dataPath);
    assert.equal(state.sheetRows.filter((row) => row.phone === "0400 000 101").length, 1);
    assert.equal(state.alerts.filter((row) => row.phone === "0400 000 101").length, 1);
    assert.equal(state.facebookLeads.filter((row) => row.phone === "0400 000 101").length, 2);
  });

  it("retries a failed delivery once and then stops", async () => {
    assert.equal((await admin(base, "/admin/fail-once", { leadgenId: PEOPLE.casey.leadgenId })).status, 200);
    assert.equal((await admin(base, "/admin/deliver", { leadgenId: PEOPLE.casey.leadgenId })).status, 200);
    const state = readState(dataPath);
    const attempts = state.attempts.filter((row) => row.leadgenId === PEOPLE.casey.leadgenId);
    assert.deepEqual(
      attempts.map((row) => row.outcome),
      ["down", "ok"],
    );
    assert.equal(attempts[0]?.httpStatus, 503);
    assert.equal(attempts[1]?.httpStatus, 200);
    assert.ok((attempts[1]?.waitedMs ?? 0) > 0);
    assert.equal(state.sheetRows.filter((row) => row.leadgenId === PEOPLE.casey.leadgenId).length, 1);
    assert.equal(state.alerts.filter((row) => row.leadgenId === PEOPLE.casey.leadgenId).length, 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const later = readState(dataPath).attempts.filter((row) => row.leadgenId === PEOPLE.casey.leadgenId);
    assert.equal(later.length, 2);
  });

  it("never writes a forged request", async () => {
    const before = readState(dataPath);
    const res = await admin(base, "/admin/forge", { leadgenId: FORGED_ID, formId: FORM_ID, pageId: PAGE_ID });
    assert.equal(res.status, 200);
    const state = readState(dataPath);
    assert.equal(state.facebookLeads.length, before.facebookLeads.length);
    assert.equal(state.sheetRows.length, before.sheetRows.length);
    assert.equal(state.alerts.length, before.alerts.length);
    const rejected = state.attempts.filter((row) => row.leadgenId === FORGED_ID);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.outcome, "rejected");
    assert.equal(rejected[0]?.httpStatus, 401);
    assert.equal(state.facebookLeads.some((row) => row.leadgenId === FORGED_ID), false);
    assert.equal(state.sheetRows.some((row) => row.leadgenId === FORGED_ID), false);
  });

  it("turns a stored New row into Contacted", async () => {
    assert.equal(
      (await admin(base, "/admin/status", { leadgenId: PEOPLE.jordan.leadgenId, status: "Contacted" })).status,
      200,
    );
    const state = readState(dataPath);
    assert.equal(state.sheetRows.find((row) => row.leadgenId === PEOPLE.jordan.leadgenId)?.status, "Contacted");
    const html = await (await fetch(`${base}/sheet`)).text();
    assert.match(html, /Contacted/);
    assert.match(html, />New</);
  });
});

describe("a failed delivery is retried once even when it keeps failing", () => {
  let server: Server;
  let base = "";
  let dataPath = "";

  before(async () => {
    const started = await boot();
    server = started.server;
    base = started.base;
    dataPath = started.dataPath;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("stops after the one retry and writes nothing", async () => {
    assert.equal((await admin(base, "/admin/graph", personBody(PEOPLE.casey))).status, 200);
    assert.equal((await admin(base, "/admin/fail-always", { leadgenId: PEOPLE.casey.leadgenId })).status, 200);
    assert.equal((await admin(base, "/admin/deliver", { leadgenId: PEOPLE.casey.leadgenId })).status, 200);
    const state = readState(dataPath);
    const attempts = state.attempts.filter((row) => row.leadgenId === PEOPLE.casey.leadgenId);
    assert.deepEqual(
      attempts.map((row) => row.outcome),
      ["down", "down"],
    );
    assert.equal(state.sheetRows.length, 0);
    assert.equal(state.facebookLeads.length, 0);
    assert.equal(state.alerts.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      readState(dataPath).attempts.filter((row) => row.leadgenId === PEOPLE.casey.leadgenId).length,
      2,
    );
  });
});

describe("same person outside the short window", () => {
  let server: Server;
  let base = "";
  let dataPath = "";

  before(async () => {
    const started = await boot({ window: 10 });
    server = started.server;
    base = started.base;
    dataPath = started.dataPath;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("keeps a later enquiry from the same phone", async () => {
    const again = {
      ...PEOPLE.jordan,
      leadgenId: "1001001001888",
      email: "later.jordan@example.com",
      want: "Supper for 12",
    };
    assert.equal((await admin(base, "/admin/graph", personBody(PEOPLE.jordan))).status, 200);
    assert.equal((await admin(base, "/admin/graph", personBody(again))).status, 200);
    assert.equal((await admin(base, "/admin/deliver", { leadgenId: PEOPLE.jordan.leadgenId })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await admin(base, "/admin/deliver", { leadgenId: again.leadgenId })).status, 200);
    const state = readState(dataPath);
    assert.equal(state.sheetRows.length, 2);
    assert.equal(state.alerts.length, 2);
  });
});

describe("old way", () => {
  let server: Server;
  let base = "";
  let dataPath = "";

  before(async () => {
    const started = await boot({ exportDelay: 80 });
    server = started.server;
    base = started.base;
    dataPath = started.dataPath;
    assert.equal((await admin(base, "/admin/mode", { mode: "old" })).status, 200);
    assert.equal((await admin(base, "/admin/graph", personBody(PEOPLE.jordan))).status, 200);
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("does nothing extra until someone copies by hand", async () => {
    assert.equal((await admin(base, "/admin/deliver", { leadgenId: PEOPLE.jordan.leadgenId })).status, 200);
    assert.equal((await admin(base, "/admin/deliver", { leadgenId: PEOPLE.jordan.leadgenId })).status, 200);
    const waiting = readState(dataPath);
    assert.equal(waiting.facebookLeads.length, 1);
    assert.equal(waiting.facebookLeads[0]?.notifyCount, 2);
    assert.equal(waiting.sheetRows.length, 0);
    assert.equal(waiting.alerts.length, 0);
    assert.equal(waiting.exportBatch, null);
    const copied = await admin(base, "/admin/copy");
    assert.equal(copied.status, 200);
    const body = (await copied.json()) as { copied: number };
    assert.equal(body.copied, 2);
    const state = readState(dataPath);
    assert.equal(state.sheetRows.length, 2);
    assert.equal(state.alerts.length, 0);
    assert.ok((state.exportBatch?.delayMs ?? 0) >= 70);
    assert.equal(state.sheetRows.every((row) => row.phone === "0400 000 101"), true);
  });

  it("still does nothing extra when the mode is switched back and copy is asked again", async () => {
    assert.equal((await admin(base, "/admin/reset", { mode: "fixed" })).status, 200);
    assert.equal((await admin(base, "/admin/deliver", { leadgenId: PEOPLE.jordan.leadgenId })).status, 200);
    const beforeCopy = readState(dataPath).sheetRows.length;
    const copied = await admin(base, "/admin/copy");
    assert.equal(copied.status, 200);
    assert.equal(((await copied.json()) as { copied: number }).copied, 0);
    assert.equal(readState(dataPath).sheetRows.length, beforeCopy);
    assert.equal(readState(dataPath).alerts.length, 1);
  });
});

describe("the same leads, both ways", () => {
  let server: Server;
  let base = "";
  let dataPath = "";

  before(async () => {
    const started = await boot({ exportDelay: 400, retry: 30 });
    server = started.server;
    base = started.base;
    dataPath = started.dataPath;
    await runBoth(base, TOKEN);
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("stores a before run that misses, repeats, and turns a forgery away", () => {
    const before = readState(dataPath).snapshots.before;
    assert.ok(before);
    assert.equal(before.mode, "old");
    assert.equal(before.facebookLeads.length, 4);
    assert.equal(before.sheetRows.length, 3);
    assert.equal(before.alerts.length, 0);
    assert.equal(before.sheetRows.filter((row) => row.name === PEOPLE.riley.name).length, 2);
    assert.equal(before.sheetRows.some((row) => row.name === PEOPLE.casey.name), false);
    assert.equal(before.sheetRows.some((row) => row.name === PEOPLE.avery.name), false);
    assert.equal(before.facebookLeads.some((row) => row.name === PEOPLE.casey.name), true);
    assert.equal(before.facebookLeads.some((row) => row.name === PEOPLE.avery.name), true);
    assert.ok(before.exportBatch);
    assert.equal(before.exportBatch.rowsWritten, 3);
    assert.equal(
      before.exportBatch.snapshotted.some((row) => row.leadgenId === PEOPLE.casey.leadgenId),
      false,
    );
    assert.equal(
      before.exportBatch.snapshotted.find((row) => row.leadgenId === PEOPLE.riley.leadgenId)?.copies,
      2,
    );
    assert.ok(before.exportBatch.delayMs >= 350);
    const casey = before.attempts.filter((row) => row.leadgenId === PEOPLE.casey.leadgenId);
    assert.deepEqual(
      casey.map((row) => row.outcome),
      ["down", "ok"],
    );
    assert.equal(before.attempts.filter((row) => row.outcome === "rejected").length, 1);
    assert.equal(before.facebookLeads.some((row) => row.leadgenId === FORGED_ID), false);
  });

  it("stores an after run that keeps one row, retries once, and alerts", () => {
    const after = readState(dataPath).snapshots.after;
    assert.ok(after);
    assert.equal(after.mode, "fixed");
    assert.equal(after.facebookLeads.length, 4);
    assert.equal(after.sheetRows.length, 3);
    assert.equal(after.alerts.length, 3);
    assert.equal(after.sheetRows.filter((row) => row.name === PEOPLE.riley.name).length, 1);
    assert.equal(after.sheetRows.filter((row) => row.name === PEOPLE.casey.name).length, 1);
    assert.equal(after.sheetRows.some((row) => row.name === PEOPLE.avery.name), false);
    assert.deepEqual(
      after.alerts.map((row) => row.name).sort(),
      [PEOPLE.casey.name, PEOPLE.jordan.name, PEOPLE.riley.name],
    );
    assert.deepEqual(
      after.attempts.filter((row) => row.leadgenId === PEOPLE.casey.leadgenId).map((row) => row.outcome),
      ["down", "ok"],
    );
    assert.equal(
      after.attempts.filter((row) => row.leadgenId === PEOPLE.riley.leadgenId && row.outcome === "duplicate")
        .length,
      1,
    );
    assert.equal(after.sheetRows.every((row) => row.status === "New"), true);
    assert.equal(after.sheetRows.find((row) => row.name === PEOPLE.jordan.name)?.phone, "0400 000 101");
    assert.equal(after.sheetRows.find((row) => row.name === PEOPLE.riley.name)?.phone, "0400 000 202");
    assert.equal(after.sheetRows.find((row) => row.name === PEOPLE.casey.name)?.phone, "0400 000 303");
    assert.equal(after.exportBatch, null);
  });

  it("renders only stored figures, in plain words", async () => {
    const state = readState(dataPath);
    const before = state.snapshots.before;
    const after = state.snapshots.after;
    assert.ok(before && after);
    const pages = [
      ["/", await (await fetch(`${base}/`)).text()],
      ["/sheet", await (await fetch(`${base}/sheet`)).text()],
      ["/alerts", await (await fetch(`${base}/alerts`)).text()],
      ["/happened", await (await fetch(`${base}/happened`)).text()],
      ["/before-after", await (await fetch(`${base}/before-after`)).text()],
      ["/triage", await (await fetch(`${base}/before-after?view=triage`)).text()],
    ] as const;
    const forbidden =
      /\b(webhook|payload|signature|apis?|bots?|guid|uuid|github|demo)\b|\bAI\b|\b\d{1,2}:\d{2}\b|\b(am|pm)\b/i;
    for (const [route, html] of pages) {
      assert.match(html, /<title>Ad leads into your sheet: sample<\/title>/, route);
      assert.match(html, /Sam's Café · catering leads/, route);
      assert.match(html, /Crom Services · Australia/, route);
      assert.doesNotMatch(html, /cromservices@gmail\.com/, route);
      assert.doesNotMatch(html, /crom-tag/, route);
      assert.doesNotMatch(html, /<style/, route);
      assert.equal(html.includes(APP_SECRET), false, route);
      for (const id of [FORGED_ID, ...Object.values(PEOPLE).map((person) => person.leadgenId)]) {
        assert.equal(html.includes(id), false, `${route} leaked ${id}`);
      }
      assert.doesNotMatch(visible(html), forbidden, route);
      assert.doesNotMatch(visible(html), /\bsample\b/i, route);
      assert.doesNotMatch(visible(html), /example/i, route);
      assert.doesNotMatch(visible(html), /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, route);
    }
    const compare = pages[4][1];
    const beforeHeadline = leadHeadline(before);
    const afterHeadline = leadHeadline(after);
    assert.equal(beforeHeadline, "New leads: 3. In your sheet: 2 (1 copied twice, 1 missing)");
    assert.equal(afterHeadline, "New leads: 3. In your sheet: 3");
    assert.equal((compare.match(new RegExp(escapeRegExp(beforeHeadline), "g")) ?? []).length, 1);
    assert.equal((compare.match(new RegExp(escapeRegExp(afterHeadline), "g")) ?? []).length, 1);
    assert.equal((compare.match(new RegExp(escapeRegExp(STORY.priorLine), "g")) ?? []).length, 2);
    assert.doesNotMatch(compare, /max-width:1500px/);
    assert.equal((compare.match(/max-width:1560px/g) ?? []).length, 2);
    assert.match(compare, /white-space:nowrap/);
    assert.doesNotMatch(pages[0][1], /max-width:1560px/);
    for (const lead of before.facebookLeads) assert.match(compare, new RegExp(lead.name));
    assert.match(compare, /Copied twice/);
    assert.match(compare, /Not in your sheet/);
    assert.match(compare, /Sent again, arrived/);
    assert.match(compare, /Arrived in your sheet/);
    assert.match(compare, /Duplicate stopped/);
    assert.match(compare, /Turned away, not from Facebook/);
    assert.match(compare, /Owner alerted/);

    const triage = pages[5][1];
    assert.doesNotMatch(triage, /max-width:1560px/);
    const avery = before.facebookLeads.find((lead) => lead.name === PEOPLE.avery.name);
    assert.ok(avery);
    assert.match(triage, new RegExp(escapeRegExp(beforeHeadline)));
    assert.match(triage, /1 missing from your sheet/);
    assert.match(triage, /1 copied twice/);
    assert.match(triage, /1 slow to arrive/);
    assert.match(triage, /1 turned away, not from Facebook/);
    assert.match(triage, /Missing leads first, because a missed lead is a lost customer/);
    assert.match(triage, new RegExp(humanDate(avery.createdTime)));
    assert.match(triage, /before the switch-on and was not copied/);
    assert.match(triage, new RegExp(PEOPLE.casey.name));
    assert.match(triage, new RegExp(PEOPLE.riley.name));

    const sheet = pages[1][1];
    assert.match(sheet, /Morning tea for 12/);
    assert.match(sheet, /0400 000 101/);
    assert.match(sheet, /0400 000 202/);
    assert.match(sheet, /0400 000 303/);
    assert.match(sheet, /j•••@••••/);
    assert.match(sheet, /r•••@••••/);
    assert.match(sheet, /c•••@••••/);
    assert.doesNotMatch(sheet, /@example\.com/);
    assert.doesNotMatch(visible(sheet), /example/i);
    assert.doesNotMatch(sheet, /Office lunch for 8/);
    assert.match(sheet, />New</);

    const alerts = pages[2][1];
    assert.match(alerts, new RegExp(PEOPLE.jordan.name));
    assert.match(alerts, new RegExp(PEOPLE.riley.name));
    assert.match(alerts, new RegExp(PEOPLE.casey.name));
    assert.doesNotMatch(alerts, new RegExp(PEOPLE.avery.name));
    assert.doesNotMatch(visible(alerts), /Example/);
    assert.match(alerts, /Owner alerted/);

    const happened = pages[3][1];
    assert.match(happened, new RegExp(`${PEOPLE.jordan.name}\\. Arrived in your sheet\\. Owner alerted\\.`));
    assert.match(happened, new RegExp(`${PEOPLE.riley.name}\\. Duplicate stopped\\.`));
    assert.match(happened, new RegExp(`${PEOPLE.casey.name}\\. Sent again, arrived\\. Owner alerted\\.`));
    assert.match(happened, /Turned away, not from Facebook\./);
  });
});

describe("graph stand-in", () => {
  it("fails a lookup once and then returns the lead", async () => {
    const graph = createGraphStandIn();
    const created = new Date();
    graph.put({
      lead: personBody(PEOPLE.casey, created).lead,
      formName: FORM_NAME,
      pageId: PAGE_ID,
      adId: "4004004004004",
      createdUnix: Math.floor(created.getTime() / 1000),
    });
    graph.failNext(PEOPLE.casey.leadgenId);
    await assert.rejects(() => graph.fetchLead(PEOPLE.casey.leadgenId));
    const second = await graph.fetchLead(PEOPLE.casey.leadgenId);
    assert.equal(second.lead.id, PEOPLE.casey.leadgenId);
    assert.equal(second.formName, FORM_NAME);
  });
});
