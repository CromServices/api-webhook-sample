import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readRunFixture, resolveWritableDataFile } from "../../shared/data-file.ts";
import type { TidiedLead } from "./leadgen.ts";

export type FacebookLead = {
  leadgenId: string;
  name: string;
  phone: string;
  phoneRaw: string;
  email: string;
  want: string;
  formName: string;
  createdTime: string;
  arrivedAt: string;
  notifyCount: number;
  /** Already in Facebook before this book was opened. */
  prior: boolean;
};

export type SheetStatus = "New" | "Contacted";

export type SheetRow = {
  leadgenId: string;
  name: string;
  phone: string;
  email: string;
  want: string;
  formName: string;
  createdTime: string;
  addedAt: string;
  status: SheetStatus;
};

export type Alert = {
  leadgenId: string;
  name: string;
  phone: string;
  email: string;
  want: string;
  at: string;
};

export type AttemptOutcome = "ok" | "down" | "rejected" | "duplicate" | "unusable";

export type Attempt = {
  at: string;
  leadgenId: string;
  outcome: AttemptOutcome;
  httpStatus: number | null;
  waitedMs: number;
  elapsedMs: number;
};

export type ExportItem = {
  leadgenId: string;
  copies: number;
};

export type ExportBatch = {
  startedAt: string;
  finishedAt: string;
  delayMs: number;
  rowsWritten: number;
  snapshotted: ExportItem[];
};

export type Picture = {
  openedAt: string;
  mode: "old" | "fixed";
  facebookLeads: FacebookLead[];
  sheetRows: SheetRow[];
  alerts: Alert[];
  attempts: Attempt[];
  exportBatch: ExportBatch | null;
};

export type Snapshot = Picture & {
  savedAt: string;
};

export type CopyPhase = "idle" | "snapshotted" | "done";

export type State = Picture & {
  duplicateWindowMs: number;
  copyPhase: CopyPhase;
  pendingCopy: { startedAt: string; items: ExportItem[]; generation: number } | null;
  snapshots: { before: Snapshot | null; after: Snapshot | null };
};

export type AcceptResult = "ok" | "duplicate";

export type Store = {
  snapshot(): State;
  mode(): "old" | "fixed";
  generation(): number;
  copyPhase(): CopyPhase;
  setMode(mode: "old" | "fixed"): void;
  reset(mode: "old" | "fixed"): void;
  logAttempt(entry: Attempt): void;
  /** A lead that was already in Facebook before this book was opened. No sheet row, no alert. */
  seedExisting(lead: TidiedLead): boolean;
  /** Old: remember the notice. Fixed: one sheet row and one owner alert, or a duplicate. */
  accept(lead: TidiedLead): AcceptResult;
  beginCopy(): { generation: number } | null;
  finishCopy(generation: number): number;
  setStatus(leadgenId: string, status: SheetStatus): boolean;
  saveSnapshot(name: "before" | "after"): void;
};

const DEFAULT_WINDOW_MS = 30 * 60 * 1000;

function blank(mode: "old" | "fixed", windowMs: number): State {
  return {
    openedAt: new Date().toISOString(),
    mode,
    duplicateWindowMs: windowMs,
    facebookLeads: [],
    sheetRows: [],
    alerts: [],
    attempts: [],
    exportBatch: null,
    copyPhase: "idle",
    pendingCopy: null,
    snapshots: { before: null, after: null },
  };
}

function clonePicture(state: State): Picture {
  return {
    openedAt: state.openedAt,
    mode: state.mode,
    facebookLeads: state.facebookLeads.map((row) => ({ ...row })),
    sheetRows: state.sheetRows.map((row) => ({ ...row })),
    alerts: state.alerts.map((row) => ({ ...row })),
    attempts: state.attempts.map((row) => ({ ...row })),
    exportBatch: state.exportBatch
      ? {
          ...state.exportBatch,
          snapshotted: state.exportBatch.snapshotted.map((row) => ({ ...row })),
        }
      : null,
  };
}

const STORED_RUN = "features/ad-leads/fixtures/stored-run.json";

function isEmpty(state: State): boolean {
  return (
    state.facebookLeads.length === 0 &&
    state.sheetRows.length === 0 &&
    state.alerts.length === 0 &&
    state.attempts.length === 0 &&
    state.snapshots.before === null &&
    state.snapshots.after === null
  );
}

function readStored(file: string): State | null {
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as State;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read data store ${file}: ${message}`);
  }
}

export function openStore(
  dataPath = process.env.DATA_PATH ?? path.join(process.cwd(), "data", "leads.json"),
  duplicateWindowMs = DEFAULT_WINDOW_MS,
  seedIfEmpty = false,
): Store {
  const file = resolveWritableDataFile(dataPath, "DATA_PATH");
  let state = readStored(file) ?? blank("fixed", duplicateWindowMs);
  let generation = 1;

  function persist(): void {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, file);
  }

  if (seedIfEmpty && isEmpty(state)) {
    state = readRunFixture<State>(STORED_RUN);
    persist();
  } else if (!existsSync(file)) {
    persist();
  }

  function addSheet(lead: TidiedLead, at: string): void {
    state.sheetRows.push({
      leadgenId: lead.leadgenId,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      want: lead.want,
      formName: lead.formName,
      createdTime: lead.createdTime,
      addedAt: at,
      status: "New",
    });
  }

  function addFacebook(lead: TidiedLead, at: string): void {
    state.facebookLeads.push({
      leadgenId: lead.leadgenId,
      name: lead.name,
      phone: lead.phone,
      phoneRaw: lead.phoneRaw,
      email: lead.email,
      want: lead.want,
      formName: lead.formName,
      createdTime: lead.createdTime,
      arrivedAt: at,
      notifyCount: 1,
      prior: false,
    });
  }

  function recentPerson(lead: TidiedLead, now: number): boolean {
    for (const existing of state.facebookLeads) {
      if (existing.leadgenId === lead.leadgenId) continue;
      if (existing.phone !== lead.phone && existing.email !== lead.email) continue;
      const seen = new Date(existing.arrivedAt).getTime();
      if (now - seen <= state.duplicateWindowMs) return true;
    }
    return false;
  }

  return {
    snapshot() {
      return structuredClone(state);
    },
    mode() {
      return state.mode;
    },
    generation() {
      return generation;
    },
    copyPhase() {
      return state.copyPhase;
    },
    setMode(mode) {
      state.mode = mode;
      persist();
    },
    reset(mode) {
      const snapshots = state.snapshots;
      const windowMs = state.duplicateWindowMs;
      generation += 1;
      state = blank(mode, windowMs);
      state.snapshots = snapshots;
      persist();
    },
    logAttempt(entry) {
      state.attempts.push(entry);
      persist();
    },
    seedExisting(lead) {
      if (new Date(lead.createdTime).getTime() >= new Date(state.openedAt).getTime()) return false;
      if (state.facebookLeads.some((row) => row.leadgenId === lead.leadgenId)) return false;
      addFacebook(lead, lead.createdTime);
      const saved = state.facebookLeads.find((row) => row.leadgenId === lead.leadgenId);
      if (saved) saved.prior = true;
      persist();
      return true;
    },
    accept(lead) {
      const at = new Date().toISOString();
      if (state.mode === "old") {
        const existing = state.facebookLeads.find((row) => row.leadgenId === lead.leadgenId);
        if (existing) existing.notifyCount += 1;
        else addFacebook(lead, at);
        persist();
        return "ok";
      }
      const known = state.facebookLeads.some((row) => row.leadgenId === lead.leadgenId);
      if (known || recentPerson(lead, Date.now())) {
        if (!known) addFacebook(lead, at);
        persist();
        return "duplicate";
      }
      addFacebook(lead, at);
      addSheet(lead, at);
      state.alerts.push({
        leadgenId: lead.leadgenId,
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        want: lead.want,
        at,
      });
      persist();
      return "ok";
    },
    beginCopy() {
      if (state.mode !== "old" || state.copyPhase === "snapshotted") return null;
      const items = state.facebookLeads
        .filter((row) => !row.prior)
        .map((row) => ({ leadgenId: row.leadgenId, copies: row.notifyCount }));
      state.pendingCopy = { startedAt: new Date().toISOString(), items, generation };
      state.copyPhase = "snapshotted";
      persist();
      return { generation };
    },
    finishCopy(startedGeneration) {
      const pending = state.pendingCopy;
      state.pendingCopy = null;
      if (!pending || startedGeneration !== generation) {
        state.copyPhase = "idle";
        persist();
        return 0;
      }
      const finishedAt = new Date().toISOString();
      let rowsWritten = 0;
      for (const item of pending.items) {
        const lead = state.facebookLeads.find((row) => row.leadgenId === item.leadgenId);
        if (!lead) continue;
        for (let copy = 0; copy < item.copies; copy += 1) {
          state.sheetRows.push({
            leadgenId: lead.leadgenId,
            name: lead.name,
            phone: lead.phone,
            email: lead.email,
            want: lead.want,
            formName: lead.formName,
            createdTime: lead.createdTime,
            addedAt: finishedAt,
            status: "New",
          });
          rowsWritten += 1;
        }
      }
      state.exportBatch = {
        startedAt: pending.startedAt,
        finishedAt,
        delayMs: new Date(finishedAt).getTime() - new Date(pending.startedAt).getTime(),
        rowsWritten,
        snapshotted: pending.items.map((row) => ({ ...row })),
      };
      state.copyPhase = "done";
      persist();
      return rowsWritten;
    },
    setStatus(leadgenId, status) {
      let changed = false;
      for (const row of state.sheetRows) {
        if (row.leadgenId !== leadgenId) continue;
        row.status = status;
        changed = true;
      }
      if (changed) persist();
      return changed;
    },
    saveSnapshot(name) {
      const shot: Snapshot = { savedAt: new Date().toISOString(), ...clonePicture(state) };
      state.snapshots[name] = shot;
      persist();
    },
  };
}
