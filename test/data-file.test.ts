import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveWritableDataFile } from "../shared/data-file.ts";

describe("resolveWritableDataFile", () => {
  it("keeps DATA_PATH when that directory is writable", () => {
    const root = mkdtempSync(path.join(tmpdir(), "crom-data-file-"));
    const requested = path.join(root, "writable", "leads.json");
    assert.equal(resolveWritableDataFile(requested, "DATA_PATH"), requested);
    rmSync(root, { recursive: true, force: true });
  });

  it("falls back to a writable directory when DATA_PATH cannot be created", () => {
    const root = mkdtempSync(path.join(tmpdir(), "crom-data-file-"));
    const blocked = path.join(root, "blocked");
    mkdirSync(blocked);
    chmodSync(blocked, 0o555);
    try {
      const requested = path.join(blocked, "nested", "leads.json");
      const fallbackRoot = path.join(root, "fallback");
      const resolved = resolveWritableDataFile(requested, "DATA_PATH", fallbackRoot);
      assert.equal(resolved, path.join(fallbackRoot, "leads.json"));
    } finally {
      chmodSync(blocked, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws a clear error when DATA_PATH and the fallback are both blocked", () => {
    const root = mkdtempSync(path.join(tmpdir(), "crom-data-file-"));
    const blocked = path.join(root, "blocked");
    mkdirSync(blocked);
    chmodSync(blocked, 0o555);
    try {
      const requested = path.join(blocked, "nested", "shop.json");
      const fallbackRoot = path.join(blocked, "also-blocked");
      assert.throws(
        () => resolveWritableDataFile(requested, "ORDER_DATA_PATH", fallbackRoot),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Cannot write ORDER_DATA_PATH/);
          assert.match(error.message, /Fallback/);
          assert.match(error.message, /also not writable/);
          assert.match(error.message, /Set ORDER_DATA_PATH/);
          return true;
        },
      );
    } finally {
      chmodSync(blocked, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
