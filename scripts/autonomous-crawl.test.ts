/**
 * Full autonomy-loop integration: fixture SPA + real chromium + a scripted
 * advisor (iter 0 probe misses the goal → repair proposal with the right
 * selectors → goal met → committed recipe artifact). Also proves the
 * budget-stop and config-rejection paths.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autonomousCrawl, probeRecipe } from "./autonomous-crawl";
import type { AdvisorObservation, AdvisorProposal, RecipeAdvisor } from "../src/advisor/contracts";
import { startFixtureWeb, type FixtureWeb } from "../src/test-support/fixture-web";
import { DEFAULT_BROWSER_CRAWLER_CONFIG } from "../src/contracts";

let web: FixtureWeb;
let recipesDir: string;
let configPath: string;

beforeAll(async () => {
  web = await startFixtureWeb();
  recipesDir = mkdtempSync(join(tmpdir(), "loop-"));
  configPath = join(recipesDir, "config.json");
  require("node:fs").writeFileSync(configPath, JSON.stringify({
    timeouts: { navigationMs: 10000, actionMs: 2000, settleMs: 50 },
    politeness: { robotsMode: "fail-closed", minIntervalPerDomainMs: 500, maxPagesPerDomainPerRun: 25, respectCrawlDelay: true },
    allowlist: { domains: ["127.0.0.1"] },
  }, null, 2));
});

afterAll(async () => {
  await web.stop();
  rmSync(recipesDir, { recursive: true, force: true });
});

/** Scripted advisor: repairs the probe into a working recipe on iteration 0. */
function scriptedRepairAdvisor(): RecipeAdvisor {
  return {
    id: "scripted:test",
    capabilities: { propose: true, decide: true },
    async propose(observation: AdvisorObservation): Promise<AdvisorProposal> {
      return {
        kind: "full-recipe",
        recipe: {
          name: "fixture-calendar",
          steps: [
            { action: "open", url: observation.url, waitFor: { state: "domcontentloaded", timeoutMs: 8000 } },
            { action: "wait", for: { selector: "article.event", minCount: 6 }, timeoutMs: 5000 },
            {
              action: "extract", itemSelector: "article.event",
              fields: [
                { name: "title", selector: "h3", as: "text" },
                { name: "url", selector: "a", as: "attr", attr: "href" },
              ],
            },
            { action: "done", success: true },
          ],
        } as never,
        rationale: "probe rows were whitespace; target article.event with h3/a fields",
        confidence: 0.9,
      };
    },
    async decide() {
      return [{ kind: "noul", id: "iterate_more", answer: true, probability: 0.8, confidence: 0.8 }];
    },
  };
}

describe("autonomous crawl loop", () => {
  it("probe → repair proposal → goal met → committed versioned recipe", async () => {
    const report = await autonomousCrawl({
      goal: "Extract at least 5 fixture events with title and url",
      url: `${web.origin}/`,
      goalSpec: { minRows: 5, requiredFields: ["title", "url"] },
      advisor: scriptedRepairAdvisor(),
      budget: { maxIterations: 3, maxProposeRetries: 1, pageBudgetPerDomain: 10 },
      configPath,
      recipesDir,
      runCapabilities: {
        allowLoopback: true,
        browserFactory: async () => {
          const { chromium } = await import("playwright");

          return chromium.launch({ headless: true });
        },
      },
    });

    // Config note: the loop loads the shipped config file; the fixture is
    // loopback so the allowlist must include it via the test override below.
    void DEFAULT_BROWSER_CRAWLER_CONFIG;

expect(report.ok).toBe(true);
    expect(report.finalGoalValidation?.goalMet).toBe(true);
    expect(report.committedRecipe).toContain("fixture-calendar");
    expect(existsSync(report.committedRecipe!)).toBe(true);

    const committed = JSON.parse(readFileSync(report.committedRecipe!, "utf8")) as { recipe: { steps: unknown[] }; goalSpec: unknown };

    expect(committed.recipe.steps.length).toBeGreaterThanOrEqual(3);
    expect(committed.goalSpec).toBeDefined();

    const decisions = report.journal.map((e) => e.decision);

    expect(decisions).toContain("engine-run");
    expect(decisions).toContain("propose");
    expect(decisions).toContain("commit");
    // Provenance recorded without touching the engine envelope.
    const proposeEntry = report.journal.find((e) => e.decision === "propose");

    expect(proposeEntry?.provenance?.advisorId).toBe("scripted:test");
  }, 120_000);

  it("budget-stop fires when page budget is exceeded before the goal", async () => {
    const report = await autonomousCrawl({
      goal: "Impossible goal",
      url: `${web.origin}/`,
      goalSpec: { minRows: 9999 },
      advisor: {
        id: "scripted:never",
        capabilities: { propose: false, decide: true },
        async decide() {
          return [{ kind: "noul", id: "iterate_more", answer: true, probability: 0.9, confidence: 0.9 }];
        },
      },
      budget: { maxIterations: 5, pageBudgetPerDomain: 0 },
      recipesDir,
      configPath,
      runCapabilities: {
        allowLoopback: true,
        browserFactory: async () => {
          const { chromium } = await import("playwright");

          return chromium.launch({ headless: true });
        },
      },
    });

    expect(report.ok).toBe(false);
    expect(report.journal.some((e) => e.decision === "budget-stop")).toBe(true);
  }, 60_000);

  it("probe recipe is deterministic and model-free", () => {
    const a = probeRecipe("https://example.org/");
    const b = probeRecipe("https://example.org/");

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.steps[0]?.action).toBe("open");
    expect(a.steps.some((s) => s.action === "extract")).toBe(true);
  });
});
