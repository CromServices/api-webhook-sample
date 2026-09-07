import express, { type Request, type Response } from "express";
import { verifyHmacHeader } from "./verify.ts";

export type AppOptions = {
  /** Shared secret for HMAC verification (sample default for local demos) */
  webhookSecret: string;
};

/**
 * Build an Express app with POST /webhook that verifies X-Signature-256.
 */
export function createApp(opts: AppOptions) {
  const app = express();

  // Need raw body for HMAC; use verify callback to keep a string copy
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  app.post("/webhook", (req: Request, res: Response) => {
    const raw =
      (req as Request & { rawBody?: string }).rawBody ??
      JSON.stringify(req.body ?? {});
    const signature = req.header("x-signature-256") ?? undefined;

    if (!verifyHmacHeader(opts.webhookSecret, raw, signature)) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    res.status(200).json({ received: true });
  });

  return app;
}
