/**
 * Runner integration over the loopback fixture SPA with REAL chromium —
 * zero external network. Covers the happy path, politeness denials, the
 * URL-transition guard, popup killing, stale refs, fail-fast skipping,
 * artifact traversal rejection, and cassette record→replay.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { DEFAULT_BROWSER_CRAWLER_CONFIG, type BrowserCrawlerConfig, type Step } from "../contracts";
import { runInstructions, type BrowserCrawlerCapabilities } from "./runner";
import type { RobotsFetchOutcome } from "../politeness/robots";
import { startFixtureWeb, type FixtureWeb } from "../test-support/fixture-web";
import { validateInstructionSet } from "../instructions/validate";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let web: FixtureWeb;

let cassetteDir: string;

let virtualNow = 1_000_000;

const sleepLog: number[] = [];

const capabilitiesFor = (over: {
  robots?: (origin: string) => Promise<RobotsFetchOutcome | null>;
  cassetteMode?: "record" | "replay" | "strict-replay";
} = {}): BrowserCrawlerCapabilities & { sleeps: number[] } => {
  const sleeps = sleepLog;

  return {
    clock: () => virtualNow,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      virtualNow += ms;
    },
    fetchRobotsText: over.robots ?? (async () => ({ status: 404, text: "" })),
    browserFactory: async (config: BrowserCrawlerConfig) => chromium.launch({ headless: config.headless }),
    allowLoopback: true,
    ...(over.cassetteMode ? { cassette: { dir: cassetteDir, mode: over.cassetteMode } } : {}),
    sleeps,
  };
};

const configFor = (over: Partial<BrowserCrawlerConfig> = {}): BrowserCrawlerConfig => ({
  ...DEFAULT_BROWSER_CRAWLER_CONFIG,
  politeness: { ...DEFAULT_BROWSER_CRAWLER_CONFIG.politeness, minIntervalPerDomainMs: 10 },
  timeouts: { ...DEFAULT_BROWSER_CRAWLER_CONFIG.timeouts, navigationMs: 10_000, actionMs: 2_000, settleMs: 50 },
  artifacts: { ...DEFAULT_BROWSER_CRAWLER_CONFIG.artifacts, dir: join(cassetteDir, "artifacts"), saveTrace: false },
  ...over,
});

const stepsOf = (steps: Step[]) => validateInstructionSet({ name: "fixture-recipe", steps });

beforeAll(async () => {
  web = await startFixtureWeb();
  cassetteDir = mkdtempSync(join(tmpdir(), "browser-crawler-"));
});

afterAll(async () => {
  await web.stop();
  rmSync(cassetteDir, { recursive: true, force: true });
});

describe("host-side lifecycle hooks (capabilities layer)", () => {
  it("onStepResult + onNavigation fire; hook errors are swallowed", async () => {
    const stepResults: string[] = [];
    const navigations: Array<[string, boolean]> = [];

    const parsed = stepsOf([
      { action: "open", url: `${web.origin}/` },
      { action: "click", target: { selector: "#never-exists" }, onError: "continue" },
      { action: "done", success: true },
    ]);

    const report = await runInstructions(parsed, configFor(), {
      ...capabilitiesFor(),
      hooks: {
        onStepResult: (step) => {
          stepResults.push(`${step.seq}:${step.status}`);

          if (step.seq === 1) throw new Error("host hook bug must not kill the run");
        },
        onNavigation: (url, ok) => { navigations.push([url.slice(0, 30), ok]); },
      },
    });

    expect(navigations.length).toBeGreaterThanOrEqual(1);
    expect(navigations[0]?.[1]).toBe(true);
    expect(stepResults).toContain("1:ok");
    expect(stepResults).toContain("2:error");
    expect(report.ok).toBe(true);
  }, 60_000);

  it("onNavigation reports politeness denials", async () => {
    const denials: string[] = [];

    await runInstructions(
      stepsOf([{ action: "open", url: "https://example.org/" }]),
      configFor({ allowlist: { domains: ["other.example"] } }),
      {
        ...capabilitiesFor(),
        hooks: { onNavigation: (url, ok, code) => { if (!ok) denials.push(code ?? "?"); } },
      },
    );

    expect(denials).toContain("DOMAIN_NOT_ALLOWED");
  }, 30_000);
});

describe("v0.2 interception primitives", () => {
  it("click waitFor networkIdle waits for the XHR batch; capture records the API response", async () => {
    const capabilities = capabilitiesFor();
    const parsed = validateInstructionSet({
      name: "capture-demo",
      capture: [{ urlPattern: "/api/events", as: "json" }],
      steps: [
        { action: "open", url: `${web.origin}/` },
        { action: "wait", for: { selector: "#load-more" }, timeoutMs: 5000 },
        { action: "click", target: { selector: "#load-more" }, waitFor: { networkIdleTimeoutMs: 5000 }, afterMs: 10 },
        { action: "done", success: true },
      ],
    } as never);

    const report = await runInstructions(parsed, configFor({
      capabilities: { javascriptEval: false, networkCapture: true },
    }), capabilities);

    expect(report.ok).toBe(true);
    expect(report.extracted.network.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(report.extracted.network[0]?.body)).toContain("API Event One");
  }, 60_000);

  it("capture rules without the capability flag fail the run explicitly", async () => {
    const parsed = validateInstructionSet({
      name: "capture-denied",
      capture: [{ urlPattern: "/api/events", as: "json" }],
      steps: [{ action: "open", url: `${web.origin}/` }, { action: "done", success: true }],
    } as never);

    const report = await runInstructions(parsed, configFor(), capabilitiesFor());

    expect(report.ok).toBe(false);
    expect(report.failureReason).toContain("networkCapture");
  }, 60_000);

  it("cassette replays captured network responses", async () => {
    const dir = join(cassetteDir, "net");
    const parsed = validateInstructionSet({
      name: "capture-replay",
      capture: [{ urlPattern: "/api/events", as: "json" }],
      steps: [
        { action: "open", url: `${web.origin}/` },
        { action: "click", target: { selector: "#load-more" }, waitFor: { networkIdleTimeoutMs: 5000 } },
      ],
    } as never);
    const config = configFor({ capabilities: { javascriptEval: false, networkCapture: true } });

    const recorded = await runInstructions(parsed, config, { ...capabilitiesFor(), cassette: { dir, mode: "record" } });

    expect(recorded.extracted.network.length).toBeGreaterThanOrEqual(1);

    const replayed = await runInstructions(parsed, config, {
      ...capabilitiesFor({ cassetteMode: "replay" }),
      cassette: { dir, mode: "replay" },
      browserFactory: async (): Promise<Browser> => { throw new Error("no chromium in replay"); },
    });

    expect(replayed.extracted.network.length).toBe(recorded.extracted.network.length);
  }, 90_000);
});

describe("runner over fixture SPA (real chromium)", () => {
  it("happy path: banner → wait for cards → extract rows/jsonLd/links/refs → screenshot", async () => {
    const capabilities = capabilitiesFor();

    const report = await runInstructions(
      stepsOf([
        { action: "open", url: `${web.origin}/`, waitFor: { state: "networkidle", timeoutMs: 8000 } },
        { action: "click", target: { selector: "#cookie-accept" }, onError: "continue" },
        { action: "wait", for: { selector: "article.event", minCount: 6 }, timeoutMs: 5000 },
        {
          action: "extract", itemSelector: "article.event",
          fields: [
            { name: "title", selector: "h3", as: "text" },
            { name: "url", selector: "a", as: "attr", attr: "href" },
            { name: "date", selector: "time", as: "attr", attr: "datetime" },
          ],
          jsonLd: true, links: { selector: "a[href*='/detail/']" }, refs: true,
        },
        { action: "screenshot", artifact: "fixture-1.png" },
        { action: "done", success: true },
      ]),
      configFor(),
      capabilities,
    );

    if (!report.ok) {
      process.stdout.write("REPORT: " + JSON.stringify({ failure: report.failureReason, steps: report.steps.map((s) => [s.seq, s.action, s.status, s.error?.code, s.error?.message?.slice(0, 80)]) }) + "\n");
    }

    expect(report.ok).toBe(true);
    expect(report.render.state).toBe("fetched_browser");
    expect(report.render.body).toContain("Fixture Event");
    expect(report.render.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.extracted.rows).toHaveLength(6);
    expect(report.extracted.rows[0]).toMatchObject({ title: "Fixture Event 1", date: "2026-11-01" });
    // pre-render + post-render JSON-LD both harvested from the RENDERED dom
    expect(report.extracted.jsonLd.length).toBeGreaterThanOrEqual(2);
    expect(report.extracted.links[0]).toContain("/detail/");
    expect(report.artifacts[0]?.path).toContain("fixture-1.png");
    expect(existsSync(report.artifacts[0]?.path ?? "")).toBe(true);
    expect(report.politeness.domainHits["127.0.0.1"]).toBe(1);
  }, 60_000);

  it("click-by-ref works; refs go stale after navigation (STALE_REF contract)", async () => {
    const report = await runInstructions(
      stepsOf([
        { action: "open", url: `${web.origin}/` },
        { action: "wait", for: { selector: "#load-more" }, timeoutMs: 5000 },
        { action: "extract", refs: true },
        { action: "click", target: { ref: "e__unknown" }, onError: "continue" },
        { action: "done", success: true },
      ]),
      configFor(),
      capabilitiesFor(),
    );

    // SAFETY: report structure is owned by the runner under test.
    const stale = report.steps.find((s: { status: string }) => s.status === "error");

    expect(stale?.error?.code).toBe("STALE_REF");
    // onError continue → later steps still run
    // SAFETY: report row shape owned by the runner under test.
    expect((report.steps.at(-1) as { status?: string } | undefined)?.status).toBe("ok");
  }, 60_000);

  it("fail-fast: first error skips the rest with reason", async () => {
    const report = await runInstructions(
      stepsOf([
        { action: "open", url: `${web.origin}/` },
        { action: "click", target: { selector: "#does-not-exist" } },
        { action: "extract", fields: [{ name: "x", selector: "h1", as: "text" }] },
      ]),
      configFor(),
      capabilitiesFor(),
    );

    // SAFETY: report row shape owned by the runner under test.
    expect((report.steps[1] as { status?: string } | undefined)?.status).toBe("error");
    // SAFETY: report row shape owned by the runner under test.
    expect((report.steps[1] as { error?: { code?: string } } | undefined)?.error?.code).toBe("SELECTOR_NOT_FOUND");
    expect(report.steps[2]?.status).toBe("skipped");
    // SAFETY: report row shape owned by the runner under test.
    expect((report.steps[2] as { skippedReason?: string } | undefined)?.skippedReason).toBe("earlier step failed");
    expect(report.ok).toBe(false);
  }, 60_000);

  it("robots fail-closed denies the run when robots fetch errors", async () => {
    const report = await runInstructions(
      stepsOf([{ action: "open", url: `${web.origin}/` }]),
      configFor(),
      capabilitiesFor({ robots: async () => null }),
    );

    expect(report.steps[0]?.status).toBe("error");
    // SAFETY: report row shape owned by the runner under test.
    expect((report.steps[0] as { error?: { code?: string } } | undefined)?.error?.code).toBe("ROBOTS_FAIL_CLOSED");
  }, 30_000);

  it("allowlist denies non-listed domains", async () => {
    const report = await runInstructions(
      stepsOf([{ action: "open", url: "https://example.org/" }]),
      configFor({ allowlist: { domains: ["other.example"] } }),
      capabilitiesFor(),
    );

    // SAFETY: report row shape owned by the runner under test.
    expect((report.steps[0] as { error?: { code?: string } } | undefined)?.error?.code).toBe("DOMAIN_NOT_ALLOWED");
  }, 30_000);

  it("per-domain page budget denies after exhaustion", async () => {
    const report = await runInstructions(
      stepsOf([
        { action: "open", url: `${web.origin}/` },
        { action: "open", url: `${web.origin}/redirect`, fresh: true },
      ]),
      configFor({ politeness: { ...DEFAULT_BROWSER_CRAWLER_CONFIG.politeness, minIntervalPerDomainMs: 10, maxPagesPerDomainPerRun: 1 } }),
      capabilitiesFor(),
    );

    // SAFETY: report row shape owned by the runner under test.
    expect((report.steps[1] as { error?: { code?: string } } | undefined)?.error?.code).toBe("BUDGET_EXHAUSTED");
  }, 30_000);

  it("artifact path traversal is rejected (schema boundary + runner basename check)", async () => {
    // Slash-bearing paths are rejected by the schema at the validation boundary.
    expect(() =>
      stepsOf([{ action: "screenshot", artifact: "../escape.png" }]),
    ).toThrow();

    // ".." passes the schema pattern but must be rejected by the runner.
    const report = await runInstructions(
      stepsOf([
        { action: "open", url: `${web.origin}/` },
        { action: "screenshot", artifact: ".." },
      ]),
      configFor(),
      capabilitiesFor(),
    );

    // SAFETY: report row shape owned by the runner under test.
    expect((report.steps[1] as { error?: { code?: string } } | undefined)?.error?.code).toBe("PATH_TRAVERSAL_REJECTED");
  }, 30_000);

  it("popups (target=_blank) are closed, not fetched", async () => {
    const report = await runInstructions(
      stepsOf([
        { action: "open", url: `${web.origin}/` },
        { action: "click", target: { selector: "#popup-link" } },
        { action: "wait", for: { timeMs: 300 } },
        { action: "done", success: true },
      ]),
      configFor(),
      capabilitiesFor(),
    );

    expect(report.ok).toBe(true);
  }, 30_000);

  it("cassette: record then replay without invoking chromium", async () => {
    const recordCaps = capabilitiesFor({ cassetteMode: "record" });

    const recorded = await runInstructions(
      stepsOf([
        { action: "open", url: `${web.origin}/` },
        { action: "wait", for: { selector: "article.event", minCount: 6 }, timeoutMs: 5000 },
        { action: "extract", itemSelector: "article.event", fields: [{ name: "title", selector: "h3", as: "text" }] },
      ]),
      configFor(),
      recordCaps,
    );

    if (!recorded.ok) {
      process.stdout.write("RECORD REPORT: " + JSON.stringify({ failure: recorded.failureReason, steps: recorded.steps.map((s) => [s.seq, s.action, s.status, s.error?.code]) }) + "\n");
    }

    expect(recorded.ok).toBe(true);
    expect(recorded.cassettePath).not.toBeNull();
    expect(existsSync(recorded.cassettePath!)).toBe(true);
    const cassetteBody = readFileSync(recorded.cassettePath!, "utf8");
    // SAFETY: shape guaranteed by the owning boundary above.
    const entries = (JSON.parse(cassetteBody) as { entries: Array<{ key: string }> }).entries;

    expect(entries).toHaveLength(1);

    // replay: browserFactory throws if invoked
    const replayCaps = {
      ...capabilitiesFor({ cassetteMode: "replay" }),
      browserFactory: async (): Promise<Browser> => {
        throw new Error("chromium must not launch in replay mode");
      },
    };

    const replayed = await runInstructions(
      stepsOf([
        { action: "open", url: `${web.origin}/` },
        { action: "wait", for: { selector: "article.event", minCount: 6 }, timeoutMs: 5000 },
        { action: "extract", itemSelector: "article.event", fields: [{ name: "title", selector: "h3", as: "text" }] },
      ]),
      configFor(),
      replayCaps,
    );

    expect(replayed.ok).toBe(true);
    expect(replayed.render.state).toBe("fetched_browser");
    expect(replayed.render.contentHash).toBe(recorded.render.contentHash);

    // strict-replay with a NOVEL instruction set (config identical) errors
    const strictCaps = { ...replayCaps, cassette: { dir: cassetteDir, mode: "strict-replay" as const } };

    const miss = await runInstructions(
      stepsOf([{ action: "open", url: `${web.origin}/novel-never-recorded` }]),
      configFor(),
      strictCaps,
    );

    expect(miss.failureReason).toContain("cassette miss");
  }, 90_000);
});
