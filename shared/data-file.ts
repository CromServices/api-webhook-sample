import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DENIED = new Set(["EACCES", "EPERM", "EROFS"]);

function codeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : "";
  }
  return "";
}

function ensureWritableDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  accessSync(dir, constants.W_OK);
}

/**
 * Honour `requested` (the DATA_PATH or ORDER_DATA_PATH value) when that
 * directory can be created and written. A permission error falls back to a
 * file of the same name under `fallbackRoot`. If that is also not writable,
 * throw an error that names both paths and the environment variable.
 */
export function resolveWritableDataFile(
  requested: string,
  envName: string,
  fallbackRoot = path.join(tmpdir(), "crom-api-webhook-sample"),
): string {
  const dir = path.dirname(requested);
  try {
    ensureWritableDir(dir);
    return requested;
  } catch (error) {
    const code = codeOf(error);
    if (!DENIED.has(code)) throw error;
    const fallback = path.join(fallbackRoot, path.basename(requested));
    try {
      ensureWritableDir(path.dirname(fallback));
    } catch (fallbackError) {
      const fallbackCode = codeOf(fallbackError) || "error";
      throw new Error(
        `Cannot write ${envName} at ${requested} (${code}). ` +
          `Fallback ${fallback} is also not writable (${fallbackCode}). ` +
          `Set ${envName} to a file path the process can create.`,
      );
    }
    console.warn(`${envName} directory ${dir} is not writable (${code}). Using ${fallback}.`);
    return fallback;
  }
}

type RunFile = {
  snapshots?: { before: unknown; after: unknown } | null;
};

/** Committed before-and-after run. Used when a data store is empty on boot. */
export function readRunFixture<T extends RunFile>(relativePath: string): T {
  const fixture = path.join(process.cwd(), relativePath);
  if (!existsSync(fixture)) {
    throw new Error(`Cannot reseed an empty data store. The fixture ${fixture} is missing.`);
  }
  let parsed: T;
  try {
    parsed = JSON.parse(readFileSync(fixture, "utf8")) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot reseed an empty data store from ${fixture}: ${message}`);
  }
  if (!parsed.snapshots?.before || !parsed.snapshots?.after) {
    throw new Error(`Cannot reseed an empty data store. ${fixture} has no before-and-after run.`);
  }
  return parsed;
}
