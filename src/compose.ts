import express, { type Express, type Request, type Response } from "express";
import { createApp as createLeadsApp } from "../features/ad-leads/app.ts";
import { createApp as createOrdersApp, type DemoApp } from "../features/order-sync/app.ts";

export type ServerOptions = {
  webhookSecret: string;
  appSecret?: string;
  verifyToken?: string;
  leadsDataPath?: string;
  ordersDataPath?: string;
  adminToken?: string;
  /** Port this process listens on, so deliveries post back to this process. */
  port?: number;
  /** Load the committed before-and-after runs when a data file is empty. */
  seedIfEmpty?: boolean;
};

/**
 * Order-sync paths that do not exist on the leads sample.
 * GET / stays the leads page. The order-sync home is also served at
 * GET /shop-and-stock, which is the same handler as that feature's GET /.
 */
const ORDER_PATHS = new Set([
  "/shop",
  "/stock",
  "/history",
  "/demo",
  "/shop-before-after",
  "/shop/orders",
  "/admin/stock",
  "/admin/slow",
  "/admin/bad-delivery",
  "/admin/resend",
]);

export type RunningApp = Express & { resumePending: () => void };

export function createServerApp(opts: ServerOptions): RunningApp {
  const port = opts.port ?? Number(process.env.PORT ?? 3000);
  const leads = createLeadsApp({
    webhookSecret: opts.webhookSecret,
    appSecret: opts.appSecret,
    verifyToken: opts.verifyToken,
    dataPath: opts.leadsDataPath,
    adminToken: opts.adminToken,
    seedIfEmpty: opts.seedIfEmpty,
    leadgenUrl: () => `http://127.0.0.1:${port}/leadgen`,
  });
  const orders: DemoApp = createOrdersApp({
    webhookSecret: opts.webhookSecret,
    dataPath: opts.ordersDataPath,
    adminToken: opts.adminToken,
    seedIfEmpty: opts.seedIfEmpty,
    webhookUrl: () => `http://127.0.0.1:${port}/webhook`,
  });

  const app = express();
  app.use((req: Request, res: Response, next) => {
    const shopHome = req.method === "GET" && req.path === "/shop-and-stock";
    const signedCheck = req.method === "POST" && req.path === "/webhook";
    if (shopHome) req.url = "/";
    const target = shopHome || signedCheck || ORDER_PATHS.has(req.path) ? orders : leads;
    target(req, res, next);
  });

  return Object.assign(app, {
    resumePending() {
      orders.resumePending();
    },
  });
}
