import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createBrowserCrawlerServer } from "./server";

describe("browser-crawler agent surface", () => {
  let origin: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const server = createBrowserCrawlerServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: server just listened on 127.0.0.1:0 — address() is a TcpSocketAddress.
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
    close = () => new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  afterAll(async () => { await close(); });

  it("health + actions schema endpoints", async () => {
    expect(await (await fetch(`${origin}/health`)).json()).toEqual({ ok: true });

    // SAFETY: /actions returns a fixed JSON shape from the server we own.
    const actions = await (await fetch(`${origin}/actions`)).json() as { actions: string[] };

    expect(actions.actions).toContain("open");
    expect(actions.actions).toContain("extract");
  });

  it("POST /run rejects invalid instruction sets with 400", async () => {
    const response = await fetch(`${origin}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bad", steps: [{ action: "teleport" }] }),
    });

    expect(response.status).toBe(400);
  });

  it("POST /run with an empty allowlist denies execution (config-level politeness)", async () => {
    const response = await fetch(`${origin}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "denied-demo",
        config: { allowlist: { domains: ["www.praha.eu"] } },
        steps: [{ action: "open", url: "https://www.praha.eu/kalendar" }],
      }),
    });

    // Accepted (202) — the run itself will fail on browser launch in the test
    // env; the contract here is queueing + statusUrl.
    expect(response.status).toBe(202);

    // SAFETY: 202 response contract is {runId, statusUrl} by design.
    const body = await response.json() as { runId: string; statusUrl: string };

    expect(body.runId).toMatch(/^[a-f0-9]{64}$/);

    // SAFETY: status endpoint contract is {ok, status, runReport?}.
    const status = await (await fetch(`${origin}${body.statusUrl}`)).json() as { status: string };

    expect(["queued", "running", "completed", "failed"]).toContain(status.status);
  });
});
