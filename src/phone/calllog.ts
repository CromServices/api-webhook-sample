import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CallSummary } from "./flow.ts";

export type CallLogEntry = CallSummary & {
  startedAt: string;
  endedAt: string;
};

export type CallLog = {
  add(entry: CallLogEntry): void;
  /** Newest first. */
  list(): CallLogEntry[];
};

const KEEP = 1000;

/**
 * Private call log. With a file path it is kept on disk (put that path on a
 * Fly volume to keep it across restarts); without one it lives in memory.
 */
export function openCallLog(filePath?: string): CallLog {
  let rows: CallLogEntry[] = [];
  if (filePath) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    if (existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
        if (Array.isArray(parsed)) rows = parsed as CallLogEntry[];
      } catch {
        rows = [];
      }
    }
  }

  function persist(): void {
    if (!filePath) return;
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows, null, 2));
    renameSync(tmp, filePath);
  }

  return {
    add(entry) {
      rows.push(structuredClone(entry));
      if (rows.length > KEEP) rows = rows.slice(rows.length - KEEP);
      persist();
    },
    list() {
      return [...rows]
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
        .map((row) => structuredClone(row));
    },
  };
}
