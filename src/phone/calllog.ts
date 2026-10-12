import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CallSummary } from "./flow.ts";

export type CallLogEntry = CallSummary & {
  startedAt: string;
  endedAt: string;
  /** Private call reference (phone provider's call id). Used to match callbacks; never shown. */
  ref?: string;
  /** Whether the text to the owner went: sent, not set up yet, or not needed (null). */
  textStatus?: "sent" | "not_set_up" | null;
  /** "left" when the caller left a voicemail, "none" when they hung up at the tone. */
  voicemail?: "left" | "none" | null;
  /** Private recording location (provider URL). Only served through the signed-in page. */
  recordingUrl?: string | null;
  recordingSeconds?: number | null;
  /** Seconds the voice provider was connected (for spend). Not shown. */
  voiceSeconds?: number;
};

export type CallLog = {
  add(entry: CallLogEntry): void;
  /** Newest first. */
  list(): CallLogEntry[];
  /** Change the newest entry with this private reference. False if none. */
  update(ref: string, patch: Partial<CallLogEntry>): boolean;
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
    update(ref, patch) {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i]!.ref === ref) {
          rows[i] = { ...rows[i]!, ...structuredClone(patch) };
          persist();
          return true;
        }
      }
      return false;
    },
    list() {
      return [...rows]
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
        .map((row) => structuredClone(row));
    },
  };
}
