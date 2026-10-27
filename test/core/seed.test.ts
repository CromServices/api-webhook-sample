import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { openStore } from "../../src/store.ts";

describe("sample shop seed", () => {
  it("starts a missing data file from the saved sample shop", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seed-"));
    const store = openStore(path.join(dir, "demo-shop.json"), path.join(process.cwd(), "seed", "demo-shop.json"));
    const state = store.snapshot();
    assert.equal(state.shopOrders.length, 3);
    assert.equal(state.stockOrders.length, 3);
    assert.ok(state.snapshots.before && state.snapshots.after);
    assert.equal(state.mode, "fixed");
    const saved = JSON.parse(readFileSync(path.join(dir, "demo-shop.json"), "utf8"));
    assert.equal(saved.shopOrders.length, 3);
  });
});
