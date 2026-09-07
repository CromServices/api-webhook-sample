import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";
import { signBody, verifyHmacHeader } from "../src/verify.ts";

const SECRET = "test-secret-not-for-production";

describe("verifyHmacHeader", () => {
  it("accepts a matching hex signature", () => {
    const body = JSON.stringify({ event: "ping" });
    const sig = signBody(SECRET, body);
    assert.equal(verifyHmacHeader(SECRET, body, sig), true);
  });

  it("accepts sha256= prefix form", () => {
    const body = "{}";
    const sig = "sha256=" + signBody(SECRET, body);
    assert.equal(verifyHmacHeader(SECRET, body, sig), true);
  });

  it("rejects a bad signature", () => {
    assert.equal(verifyHmacHeader(SECRET, "{}", "deadbeef"), false);
  });

  it("rejects missing header", () => {
    assert.equal(verifyHmacHeader(SECRET, "{}", undefined), false);
  });
});

describe("POST /webhook", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = createApp({ webhookSecret: SECRET });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  it("returns 200 for a valid signature", async () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = signBody(SECRET, body);
    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-256": sig,
      },
      body,
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { received: boolean };
    assert.equal(json.received, true);
  });

  it("returns 401 for an invalid signature", async () => {
    const body = JSON.stringify({ hello: "world" });
    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-256": "0000000000000000000000000000000000000000000000000000000000000000",
      },
      body,
    });
    assert.equal(res.status, 401);
  });

  it("returns 401 when signature header is absent", async () => {
    const body = JSON.stringify({ hello: "world" });
    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(res.status, 401);
  });

  // close server after suite — node:test runs tests sequentially in a file
  it("shuts down the test server", async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });
});
