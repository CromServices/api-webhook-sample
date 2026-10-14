import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { deliverNotice } from "./deliver.ts";
import { createGraphStandIn, type GraphLead, type GraphStandIn, type Registration } from "./graph.ts";
import { readLeadgenNotices, tidyLead, type LeadgenNotice } from "./leadgen.ts";
import { alertsPage, comparePage, happenedPage, homePage, sheetPage } from "./pages.ts";
import { openStore, type SheetStatus } from "./store.ts";
import { verifyHmacHeader } from "../../shared/verify.ts";

/**
 * Published public sample secret for the original signed check.
 * The Facebook app secret is never this value and is never written into the repo.
 */
export const DEMO_WEBHOOK_SECRET = "crom-demo-webhook-secret-v1";

/** Fixed body used in the public docs curl examples. */
export const DEMO_WEBHOOK_BODY = '{"event":"ping"}';

export type AppOptions = {
  /** Shared secret for the original signed check. */
  webhookSecret: string;
  /** Facebook app secret. Generated at runtime when omitted. Never commit this. */
  appSecret?: string;
  /** Verify token for the handshake. Generated at runtime when omitted. */
  verifyToken?: string;
  dataPath?: string;
  /** Bearer token for the private controls. Empty means those controls stay closed. */
  adminToken?: string;
  leadgenUrl?: () => string;
  retryDelayMs?: number;
  clientTimeoutMs?: number;
  exportDelayMs?: number;
  duplicateWindowMs?: number;
  /** When the data file is missing or has no run, load the committed fixture. */
  seedIfEmpty?: boolean;
  graph?: GraphStandIn;
};

function sameToken(expected: string, given: string): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerOk(token: string, header: string | undefined): boolean {
  if (!token || !header?.startsWith("Bearer ")) return false;
  return sameToken(token, header.slice("Bearer ".length));
}

function queryText(query: Request["query"], key: string): string {
  const direct = query[key];
  if (typeof direct === "string") return direct;
  const [head, ...rest] = key.split(".");
  let current: unknown = head ? query[head] : undefined;
  for (const part of rest) {
    if (!current || typeof current !== "object") return "";
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isGraphLead(value: unknown): value is GraphLead {
  if (!value || typeof value !== "object") return false;
  const lead = value as Record<string, unknown>;
  return typeof lead.id === "string" && typeof lead.created_time === "string" && Array.isArray(lead.field_data);
}

export function createApp(opts: AppOptions): Express {
  const appSecret = opts.appSecret ?? randomBytes(32).toString("hex");
  const verifyToken = opts.verifyToken ?? randomBytes(24).toString("hex");
  const dataPath =
    opts.dataPath ?? path.join(mkdtempSync(path.join(tmpdir(), "crom-leads-")), "leads.json");
  const store = openStore(dataPath, opts.duplicateWindowMs, opts.seedIfEmpty ?? false);
  const graph = opts.graph ?? createGraphStandIn();
  const retryDelayMs = opts.retryDelayMs ?? 40;
  const clientTimeoutMs = opts.clientTimeoutMs ?? 2000;
  const exportDelayMs = opts.exportDelayMs ?? 400;
  const leadgenUrl = opts.leadgenUrl ?? (() => "http://127.0.0.1:3000/leadgen");

  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );

  function picture() {
    return store.snapshot();
  }

  function requireAdmin(req: Request, res: Response): boolean {
    if (!bearerOk(opts.adminToken ?? "", req.header("authorization") ?? undefined)) {
      res.status(401).json({ error: "not allowed" });
      return false;
    }
    return true;
  }

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  app.get("/", (_req: Request, res: Response) => {
    res.status(200).type("html").send(homePage(picture()));
  });

  app.get("/sheet", (_req: Request, res: Response) => {
    res.status(200).type("html").send(sheetPage(picture()));
  });

  app.get("/alerts", (_req: Request, res: Response) => {
    res.status(200).type("html").send(alertsPage(picture()));
  });

  app.get("/happened", (_req: Request, res: Response) => {
    res.status(200).type("html").send(happenedPage(picture()));
  });

  app.get("/before-after", (req: Request, res: Response) => {
    const state = store.snapshot();
    const view = req.query.view === "triage" ? "triage" : "side";
    res.status(200).type("html").send(comparePage(state.snapshots.before, state.snapshots.after, view));
  });

  app.get("/leadgen", (req: Request, res: Response) => {
    const mode = queryText(req.query, "hub.mode");
    const token = queryText(req.query, "hub.verify_token");
    const challenge = queryText(req.query, "hub.challenge");
    if (mode !== "subscribe" || !sameToken(verifyToken, token)) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(challenge)) {
      res.status(400).type("text/plain").send("Bad request");
      return;
    }
    res.status(200).type("text/plain").send(challenge);
  });

  app.post("/leadgen", async (req: Request, res: Response) => {
    try {
      const raw = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
      if (!verifyHmacHeader(appSecret, raw, req.header("x-hub-signature-256") ?? undefined)) {
        res.status(401).json({ error: "invalid signature" });
        return;
      }
      const notices = readLeadgenNotices(req.body);
      if (notices.length === 0) {
        res.status(200).json({ received: true });
        return;
      }
      let duplicate = false;
      for (const notice of notices) {
        let fetched: { lead: GraphLead; formName: string };
        try {
          fetched = await graph.fetchLead(notice.leadgenId);
        } catch {
          res.status(503).json({ received: false });
          return;
        }
        const lead = tidyLead(fetched.lead, fetched.formName);
        if (!lead) {
          res.status(422).json({ received: false });
          return;
        }
        if (store.accept(lead) === "duplicate") duplicate = true;
      }
      if (!res.headersSent) res.status(200).json({ received: true, duplicate });
    } catch {
      if (!res.headersSent) res.status(500).json({ received: false });
    }
  });

  app.post("/webhook", (req: Request, res: Response) => {
    const raw = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
    if (!verifyHmacHeader(opts.webhookSecret, raw, req.header("x-signature-256") ?? undefined)) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    res.status(200).json({ received: true });
  });

  app.get("/admin/state", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    res.status(200).json(store.snapshot());
  });

  app.post("/admin/mode", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const mode = req.body?.mode;
    if (mode !== "old" && mode !== "fixed") {
      res.status(400).json({ error: "not allowed" });
      return;
    }
    store.setMode(mode);
    res.status(200).json({ ok: true });
  });

  app.post("/admin/reset", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const mode = req.body?.mode === "old" ? "old" : "fixed";
    store.reset(mode);
    res.status(200).json({ ok: true });
  });

  app.post("/admin/graph", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const body = req.body ?? {};
    if (!isGraphLead(body.lead)) {
      res.status(400).json({ error: "not allowed" });
      return;
    }
    if (typeof body.formName !== "string" || typeof body.pageId !== "string" || typeof body.adId !== "string") {
      res.status(400).json({ error: "not allowed" });
      return;
    }
    if (!Number.isInteger(body.createdUnix)) {
      res.status(400).json({ error: "not allowed" });
      return;
    }
    const entry: Registration = {
      lead: body.lead,
      formName: body.formName,
      pageId: body.pageId,
      adId: body.adId,
      createdUnix: body.createdUnix,
    };
    graph.put(entry);
    res.status(200).json({ ok: true });
  });

  app.post("/admin/fail-once", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const id = typeof req.body?.leadgenId === "string" ? req.body.leadgenId : "";
    if (!graph.get(id)) {
      res.status(404).json({ error: "not allowed" });
      return;
    }
    graph.failNext(id);
    res.status(200).json({ ok: true });
  });

  app.post("/admin/fail-always", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const id = typeof req.body?.leadgenId === "string" ? req.body.leadgenId : "";
    if (!graph.get(id)) {
      res.status(404).json({ error: "not allowed" });
      return;
    }
    graph.failAlways(id);
    res.status(200).json({ ok: true });
  });

  function noticeFor(id: string): LeadgenNotice | null {
    const entry = graph.get(id);
    if (!entry) return null;
    return {
      leadgenId: entry.lead.id,
      formId: entry.lead.form_id,
      pageId: entry.pageId,
      adId: entry.adId,
      createdUnix: entry.createdUnix,
    };
  }

  app.post("/admin/deliver", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const id = typeof req.body?.leadgenId === "string" ? req.body.leadgenId : "";
    const notice = noticeFor(id);
    if (!notice) {
      res.status(404).json({ error: "not allowed" });
      return;
    }
    await deliverNotice({
      url: leadgenUrl(),
      secret: appSecret,
      notice,
      store,
      retryDelayMs,
      timeoutMs: clientTimeoutMs,
    });
    res.status(200).json({ ok: true });
  });

  app.post("/admin/forge", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const id = typeof req.body?.leadgenId === "string" ? req.body.leadgenId : "";
    const formId = typeof req.body?.formId === "string" ? req.body.formId : "0";
    const pageId = typeof req.body?.pageId === "string" ? req.body.pageId : "0";
    const notice: LeadgenNotice = {
      leadgenId: id,
      formId,
      pageId,
      adId: "0",
      createdUnix: Math.floor(Date.now() / 1000),
    };
    if (!id) {
      res.status(400).json({ error: "not allowed" });
      return;
    }
    await deliverNotice({
      url: leadgenUrl(),
      secret: appSecret,
      notice,
      store,
      retryDelayMs,
      timeoutMs: clientTimeoutMs,
      signature: `sha256=${"ab".repeat(32)}`,
    });
    res.status(200).json({ ok: true });
  });

  app.post("/admin/seed-old", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const id = typeof req.body?.leadgenId === "string" ? req.body.leadgenId : "";
    const entry = graph.get(id);
    if (!entry) {
      res.status(404).json({ error: "not allowed" });
      return;
    }
    try {
      const fetched = await graph.fetchLead(id);
      const lead = tidyLead(fetched.lead, fetched.formName);
      if (!lead || !store.seedExisting(lead)) {
        res.status(409).json({ error: "not allowed" });
        return;
      }
      res.status(200).json({ ok: true });
    } catch {
      res.status(503).json({ error: "not allowed" });
    }
  });

  app.post("/admin/copy", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const begun = store.beginCopy();
    if (!begun) {
      res.status(200).json({ ok: true, copied: 0 });
      return;
    }
    await sleep(exportDelayMs);
    const copied = store.finishCopy(begun.generation);
    res.status(200).json({ ok: true, copied });
  });

  app.post("/admin/snapshot", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const name = req.body?.name;
    if (name !== "before" && name !== "after") {
      res.status(400).json({ error: "not allowed" });
      return;
    }
    store.saveSnapshot(name);
    res.status(200).json({ ok: true });
  });

  app.post("/admin/status", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const id = typeof req.body?.leadgenId === "string" ? req.body.leadgenId : "";
    const status = req.body?.status;
    if (status !== "New" && status !== "Contacted") {
      res.status(400).json({ error: "not allowed" });
      return;
    }
    const changed = store.setStatus(id, status as SheetStatus);
    if (!changed) {
      res.status(404).json({ error: "not allowed" });
      return;
    }
    res.status(200).json({ ok: true });
  });

  return app;
}
