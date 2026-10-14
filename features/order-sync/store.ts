import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { STORY } from "./story.ts";

export type ShopOrder = {
  id: string;
  product: string;
  qty: number;
  placedAt: string;
  /** When true, this shop order is not sent on. */
  hold: boolean;
};

export type StockOrder = {
  id: string;
  product: string;
  qty: number;
  receivedAt: string;
};

export type Attempt = {
  at: string;
  orderId: string;
  product: string;
  qty: number;
  outcome: "ok" | "down" | "rejected" | "duplicate";
  httpStatus: number | null;
  waitedMs: number;
};

export type Control = {
  at: string;
  kind: string;
  detail: string;
};

export type Product = {
  name: string;
  onHand: number;
  opening: number;
};

export type Picture = {
  products: Product[];
  shopOrders: ShopOrder[];
  stockOrders: StockOrder[];
  attempts: Attempt[];
};

export type Snapshot = Picture & {
  savedAt: string;
  openedAt: string;
  mode: "old" | "fixed";
  controls: Control[];
};

export type State = Picture & {
  openedAt: string;
  mode: "old" | "fixed";
  stockUp: boolean;
  slowMs: number;
  nextId: number;
  controls: Control[];
  snapshots: { before: Snapshot | null; after: Snapshot | null };
};

export type Store = {
  snapshot(): State;
  mode(): "old" | "fixed";
  generation(): number;
  isStockUp(): boolean;
  setStockUp(up: boolean): void;
  setMode(mode: "old" | "fixed"): void;
  setSlowMs(ms: number): void;
  consumeSlow(id: string): number;
  knownProduct(name: string): boolean;
  addShopOrder(product: string, qty: number, hold?: boolean): ShopOrder | null;
  takeId(): string;
  receiveOnce(order: { id: string; product: string; qty: number }): "ok" | "duplicate" | "unknown" | "short";
  receiveAgain(order: { id: string; product: string; qty: number }): "ok" | "unknown" | "short";
  logAttempt(entry: Attempt): void;
  pending(): ShopOrder[];
  saveSnapshot(name: "before" | "after"): void;
  reset(mode: "old" | "fixed"): void;
  mark(kind: string, detail: string): void;
};

function seed(mode: "old" | "fixed"): State {
  const openedAt = new Date().toISOString();
  return {
    openedAt,
    mode,
    stockUp: true,
    slowMs: 0,
    nextId: 1041,
    products: STORY.products.map((row) => ({
      name: row.name,
      onHand: row.onHand,
      opening: row.onHand,
    })),
    shopOrders: [],
    stockOrders: [],
    attempts: [],
    controls: [],
    snapshots: { before: null, after: null },
  };
}

function picture(state: State): Picture {
  return {
    products: state.products.map((row) => ({ ...row })),
    shopOrders: state.shopOrders.map((row) => ({ ...row })),
    stockOrders: state.stockOrders.map((row) => ({ ...row })),
    attempts: state.attempts.map((row) => ({ ...row })),
  };
}

export function openStore(dataPath: string): Store {
  mkdirSync(path.dirname(dataPath), { recursive: true });
  let state: State = existsSync(dataPath)
    ? (JSON.parse(readFileSync(dataPath, "utf8")) as State)
    : seed("fixed");
  if (!existsSync(dataPath)) persist();
  let generation = 1;
  const slowUsed = new Set<string>();

  function persist(): void {
    const tmp = `${dataPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, dataPath);
  }

  function product(name: string): Product | undefined {
    return state.products.find((row) => row.name === name);
  }

  function control(kind: string, detail: string): void {
    state.controls.push({ at: new Date().toISOString(), kind, detail });
  }

  function valid(order: { product: string; qty: number }): Product | undefined {
    const item = product(order.product);
    if (!item || !Number.isInteger(order.qty) || order.qty < 1 || order.qty > 20) return undefined;
    return item;
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
    isStockUp() {
      return state.stockUp;
    },
    setStockUp(up: boolean) {
      state.stockUp = up;
      control("stock", up ? "up" : "down");
      persist();
    },
    setMode(mode: "old" | "fixed") {
      state.mode = mode;
      control("mode", mode);
      persist();
    },
    setSlowMs(ms: number) {
      state.slowMs = ms;
      control("slow", String(ms));
      persist();
    },
    consumeSlow(id: string) {
      if (state.slowMs <= 0 || slowUsed.has(id)) return 0;
      slowUsed.add(id);
      return state.slowMs;
    },
    knownProduct(name: string) {
      return product(name) !== undefined;
    },
    takeId() {
      const id = String(state.nextId);
      state.nextId += 1;
      persist();
      return id;
    },
    addShopOrder(name: string, qty: number, hold = false) {
      if (!valid({ product: name, qty })) return null;
      const order: ShopOrder = {
        id: String(state.nextId),
        product: name,
        qty,
        placedAt: new Date().toISOString(),
        hold,
      };
      state.nextId += 1;
      state.shopOrders.push(order);
      persist();
      return order;
    },
    receiveOnce(order) {
      const item = valid(order);
      if (!item) return "unknown";
      if (state.stockOrders.some((row) => row.id === order.id)) return "duplicate";
      if (item.onHand < order.qty) return "short";
      item.onHand -= order.qty;
      state.stockOrders.push({
        id: order.id,
        product: order.product,
        qty: order.qty,
        receivedAt: new Date().toISOString(),
      });
      persist();
      return "ok";
    },
    receiveAgain(order) {
      const item = valid(order);
      if (!item) return "unknown";
      if (item.onHand < order.qty) return "short";
      item.onHand -= order.qty;
      state.stockOrders.push({
        id: order.id,
        product: order.product,
        qty: order.qty,
        receivedAt: new Date().toISOString(),
      });
      persist();
      return "ok";
    },
    logAttempt(entry) {
      state.attempts.push(entry);
      persist();
    },
    pending() {
      const received = new Set(state.stockOrders.map((row) => row.id));
      const rejected = new Set(
        state.attempts.filter((row) => row.outcome === "rejected").map((row) => row.orderId),
      );
      return state.shopOrders.filter(
        (row) => !row.hold && !received.has(row.id) && !rejected.has(row.id),
      );
    },
    saveSnapshot(name) {
      const shot: Snapshot = {
        savedAt: new Date().toISOString(),
        openedAt: state.openedAt,
        mode: state.mode,
        controls: state.controls.map((row) => ({ ...row })),
        ...picture(state),
      };
      state.snapshots[name] = shot;
      control("snapshot", name);
      persist();
    },
    reset(mode) {
      const snapshots = state.snapshots;
      generation += 1;
      slowUsed.clear();
      state = seed(mode);
      state.snapshots = snapshots;
      control("reset", mode);
      persist();
    },
    mark(kind, detail) {
      control(kind, detail);
      persist();
    },
  };
}
