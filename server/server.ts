/**
 * Agent-facing localhost HTTP surface (console/server.ts precedent):
 * bare node:http, bound 127.0.0.1:9301, stateless wrapper around
 * runInstructions. Renders take minutes — POST /run answers 202 with a
 * status URL, never holding the socket.
 *
 *   POST /run   {name, config?, steps[]} → 202 {runId, statusUrl}
 *   GET  /runs/:runId                    → {status, runReport?}
 *   GET  /actions                         → machine-readable action schema
 *   GET  /health                          → {ok}
 */

import { createServer, type Server } from "node:http";
import { chromium } from "playwright";
import type { RobotsFetchOutcome } from "../src/politeness/robots";
import { Value } from "@sinclair/typebox/value";
import { InstructionSetSchema, type InstructionSet as InstructionSetLike } from "../src/contracts";
import { loadConfig, type ConfigOverride } from "../src/config/loader";
import type { CanonicalValue } from "../src/instructions/validate";
import { validateInstructionSet, sha256Of } from "../src/instructions/validate";
import { runInstructions, type BrowserCrawlerCapabilities, type RunReport } from "../src/runner/runner";

/** Named owner contract for a queued/running/completed run. */
interface QueuedRun {
  runId: string;
  status: "queued" | "running" | "completed" | "failed";
  report: RunReport | null;
}

export function createBrowserCrawlerServer(configPath?: string): Server {
  const runs = new Map<string, QueuedRun>();

  /** Named owner contract for the POST /run JSON body. */
  interface RunRequestBody extends InstructionSetLike {
    config?: ConfigOverride;
  }

  const execute = (
    runId: string,
    instructionSet: RunRequestBody["steps"],
    configOverride: ConfigOverride | undefined,
  ): void => {
    const entry = runs.get(runId);

    if (!entry) return;

    entry.status = "running";

    void (async () => {
      try {
        const config = loadConfig(configPath, configOverride);

        const capabilities: BrowserCrawlerCapabilities = {
          clock: () => Date.now(),
          sleep: (ms) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)),
          fetchRobotsText: async (origin): Promise<RobotsFetchOutcome | null> => {
            try {
              const response = await fetch(`${origin}/robots.txt`, {
                headers: { "user-agent": config.userAgent },
                signal: AbortSignal.timeout(20000),
              });

              return { status: response.status, text: await response.text() };
            } catch {
              return null;
            }
          },
          browserFactory: async (browserConfig) => chromium.launch({
            headless: browserConfig.headless,
            slowMo: browserConfig.rendering.slowMoMs,
          }),
        };

        entry.report = await runInstructions({ instructionSet, runId: sha256Of(instructionSet) }, config, capabilities);
        entry.status = "completed";
      } catch {
        entry.status = "failed";
      }
    })();
  };

  const server = createServer((request, response) => {
    const url = request.url ?? "/";

    /** Named owner contract for JSON response payloads. */
  type ResponsePayload = Record<string, string | number | boolean | null>;

  const send = (status: number, body: ResponsePayload): void => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };

    if (url === "/health") {
      send(200, { ok: true });

      return;
    }

    if (url === "/actions") {
      send(200, {
        instructionSet: Value.Schema ? { /* TypeBox compiled schema JSON */ } : {},
        actions: ["open", "click", "fill", "select", "press_key", "hover", "scroll", "wait", "extract", "screenshot", "back", "close", "done"],
        docs: "POST /run {name, config?, steps[]} — see GET /actions shape; steps are ordered, fail-fast with skip-rest marking.",
      });

      return;
    }

    if (url === "/run" && request.method === "POST") {
      let bodyText = "";

      request.on("data", (chunk) => { bodyText += chunk; });
      request.on("end", () => {
        try {
          // SAFETY: JSON.parse output validated against InstructionSetSchema
          // before any consumer reads it.
          const parsed = JSON.parse(bodyText) as CanonicalValue;
          const errors = [...Value.Errors(InstructionSetSchema, parsed)];

          if (errors.length > 0) {
            send(400, { ok: false, error: `invalid instruction set: ${errors[0]?.path}` });

            return;
          }

          const instructionSet = Value.Decode(InstructionSetSchema, Value.Clone(parsed));
          const runId = sha256Of(instructionSet);

          if (runs.has(runId)) {
            send(202, { runId, statusUrl: `/runs/${runId}`, deduplicated: true });

            return;
          }

          runs.set(runId, { runId, status: "queued", report: null });
          send(202, { runId, statusUrl: `/runs/${runId}` });
          // SAFETY: decoded InstructionSet — config is its optional override bag.
          execute(runId, instructionSet, (parsed as InstructionSetLike).config);
        } catch (error) {
          send(400, { ok: false, error: error instanceof Error ? error.message : "bad json" });
        }
      });

      return;
    }

    const runMatch = /^\/runs\/([a-f0-9]+)$/.exec(url);

    if (runMatch) {
      const entry = runs.get(runMatch[1]!);

      if (!entry) {
        send(404, { ok: false, error: "unknown runId" });

        return;
      }

      send(200, { ok: entry.status === "completed" && (entry.report?.ok ?? false), status: entry.status, runReport: entry.report });

      return;
    }

    send(404, { ok: false, error: "not found" });
  });

  return server;
}

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.BROWSER_CRAWLER_PORT ?? "9301", 10);
  const server = createBrowserCrawlerServer(process.env.BROWSER_CRAWLER_CONFIG);

  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`browser-crawler agent surface → http://127.0.0.1:${port}\n`);
  });
}

if (process.argv[1]?.includes("server/server")) {
  void main();
}
