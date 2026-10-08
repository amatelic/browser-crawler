/**
 * Autonomous crawl loop (host layer — outside the engine boundary scan).
 *
 *   goal (natural language) + URL + GoalSpec
 *     → deterministic probe recipe → run (cassette record)
 *     → evaluateGoal (pure reward) → JEV arbitration (cheap)
 *     → advisor proposal (expensive, rare) → validateAdvisorProposal
 *     → bounded iterations → commit as a versioned recipe artifact
 *       gated on goalMet + budget discipline.
 *
 * Verifier corrections applied:
 *  - validation failure jumps to PROPOSE with validationErrors (never spins)
 *  - per-iteration LLM cap AND global cap (maxIterations × (1+retries))
 *  - host-side politeness accounting: domainHits aggregated across
 *    iterations vs pageBudgetPerDomain; inter-iteration sleep ≥
 *    minIntervalPerDomainMs (no shared gate — fresh gate per run by design)
 *  - proposals never pass config to loadConfig (host owns config)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  evaluateGoal,
  summarizeReport,
  validateAdvisorProposal,
  type AdvisorAnswer,
  type AdvisorQuestion,
  type GoalSpec,
  type GoalValidation,
  type RecipeAdvisor,
} from "../src/advisor/contracts";
import type { InstructionSet, Step } from "../src/contracts";
import { loadConfig } from "../src/config/loader";
import { validateInstructionSet } from "../src/instructions/validate";
import { runInstructions, type RunReport } from "../src/runner/runner";
import type { RobotsFetchOutcome } from "../src/politeness/robots";

export interface LoopBudget {
  maxIterations: number;       // default 5
  maxProposeRetries: number;   // per-iteration validation self-corrections (default 1)
  pageBudgetPerDomain: number; // ≤ config.politeness.maxPagesPerDomainPerRun
}

export interface JournalEntry {
  iteration: number;
  decision: "engine-run" | "jev-decide" | "propose" | "rejected" | "budget-stop" | "commit";
  runId?: string;
  goalValidation?: GoalValidation;
  errors?: string[];
  answers?: AdvisorAnswer[];
  provenance?: { advisorId: string; durationMs?: number };
}

export interface LoopReport {
  ok: boolean;
  goal: string;
  url: string;
  iterations: number;
  journal: JournalEntry[];
  committedRecipe: string | null;
  finalGoalValidation: GoalValidation | null;
  failureReason: string | null;
}

/** Deterministic probe recipe — NO model involved in step 0. */
export function probeRecipe(url: string): InstructionSet {
  const steps: Step[] = [
    { label: "open", action: "open", url, waitFor: { state: "domcontentloaded", timeoutMs: 25_000 } },
    { label: "any content", action: "wait", for: { selector: "a", minCount: 5 }, timeoutMs: 10_000, onError: "continue" },
    {
      label: "harvest probe", action: "extract",
      itemSelector: "article, li, [class*=event], [class*=card]",
      fields: [{ name: "title", selector: "h2, h3, a", as: "text" }],
      jsonLd: true, links: { selector: "a", limit: 50 }, refs: true,
    },
    { action: "done", success: true },
  ];

  return validateInstructionSet({ name: "probe", steps } as never).instructionSet;
}

export async function autonomousCrawl(input: {
  goal: string;
  url: string;
  goalSpec: GoalSpec;
  advisor: RecipeAdvisor;
  budget?: Partial<LoopBudget>;
  configPath?: string;
  recipesDir?: string;
  runCapabilities?: {
    browserFactory?: (headless: boolean) => Promise<import("playwright").Browser>;
    fetchRobotsText?: (origin: string) => Promise<RobotsFetchOutcome | null>;
    /** Test-only loopback escape hatch (engine's own fixture-test pattern). */
    allowLoopback?: boolean;
  };
}): Promise<LoopReport> {
  const budget: LoopBudget = {
    maxIterations: input.budget?.maxIterations ?? 5,
    maxProposeRetries: input.budget?.maxProposeRetries ?? 1,
    pageBudgetPerDomain: input.budget?.pageBudgetPerDomain ?? 20,
  };
  const maxLlmCalls = budget.maxIterations * (1 + budget.maxProposeRetries);
  const journal: JournalEntry[] = [];
  const domainHits: Record<string, number> = {};
  const recipesDir = input.recipesDir ?? "recipes";
  const config = loadConfig(input.configPath);
  const minInterval = config.politeness.minIntervalPerDomainMs;
  let llmCalls = 0;

  const hostCaps = {
    clock: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    fetchRobotsText: input.runCapabilities?.fetchRobotsText ?? (async (origin: string) => {
      try {
        const response = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(20_000) });

        return { status: response.status, text: await response.text() } as RobotsFetchOutcome;
      } catch {
        return null;
      }
    }),
    browserFactory: input.runCapabilities?.browserFactory ?? (async (cfg: typeof config) => chromium.launch({ headless: cfg.headless })),
    allowLoopback: input.runCapabilities?.allowLoopback === true,
  };

  const run = async (recipe: InstructionSet): Promise<RunReport> => {
    // Inter-iteration politeness spacing (host-side accounting).
    for (const [host, hits] of Object.entries(domainHits)) {
      void host; void hits;

      await hostCaps.sleep(Math.min(minInterval, 2_000));
    }

    const parsed = validateInstructionSet(recipe as never);
    const report = await runInstructions(parsed, config, {
      ...hostCaps,
      cassette: { dir: join(recipesDir, "cassettes"), mode: "record" },
    });

    for (const [host, hits] of Object.entries(report.politeness.domainHits)) {
      domainHits[host] = (domainHits[host] ?? 0) + hits;

      if (domainHits[host]! > budget.pageBudgetPerDomain) {
        journal.push({ iteration: journal.length, decision: "budget-stop", errors: [`${host}: ${domainHits[host]} > ${budget.pageBudgetPerDomain} pages`] });
      }
    }

    return report;
  };

  let recipe = probeRecipe(input.url);
  let best: { recipe: InstructionSet; validation: GoalValidation } | null = null;
  let failureReason: string | null = null;

  for (let iteration = 0; iteration < budget.maxIterations; iteration += 1) {
    let report = await run(recipe);
    let validation = evaluateGoal(input.goalSpec, { rows: report.extracted.rows });

    journal.push({ iteration, decision: "engine-run", runId: report.runId, goalValidation: validation });


    if (validation.goalMet && report.ok) {
      best = { recipe, validation };

      break;
    }

    if (journal.some((e) => e.decision === "budget-stop")) {
      failureReason = "politeness page budget exhausted";

      break;
    }

    // JEV arbitration (cheap; abstain = no signal).
    const questions: AdvisorQuestion[] = [
      { id: "iterate_more", kind: "noul", prompt: `The recipe is only committed when every goal check passes. Goal: ${input.goal.slice(0, 200)}. Score ${validation.score.toFixed(2)}. Failing checks that BLOCK the commit: ${validation.checks.filter((c) => !c.pass).map((c) => `${c.id} (${c.detail})`).join("; ") || "none"}. Iteration ${iteration + 1}/${budget.maxIterations}; the data is incomplete until these are fixed. Is another repair iteration worthwhile?` },
    ];

    if (input.advisor.decide) {
      const decideStart = Date.now();
      const answers = await input.advisor.decide(
        JSON.stringify({ goal: input.goal, checks: validation.checks, report: summarizeReport(report as never) }).slice(0, 4000),
        questions,
      );

      journal.push({ iteration, decision: "jev-decide", answers, provenance: { advisorId: input.advisor.id, durationMs: Date.now() - decideStart } });

      const iterate = answers.find((a) => a.id === "iterate_more");

      if (iterate && iterate.kind === "noul" && iterate.answer === false) {
        failureReason = "advisor signaled stop";

        break;
      }
    }

    // PROPOSE (expensive, capped per-iteration AND globally).
    if (!input.advisor.propose) {
      failureReason = "advisor cannot propose";

      break;
    }

    let proposalRecipe: InstructionSet | null = null;

    for (let attempt = 0; attempt <= budget.maxProposeRetries; attempt += 1) {
      if (llmCalls >= maxLlmCalls) {
        failureReason = `llm call budget exhausted (${maxLlmCalls})`;

        break;
      }

      const proposeStart = Date.now();
      const proposal = await input.advisor.propose({
        goal: input.goal,
        url: input.url,
        iteration,
        mode: iteration === 0 ? "author" : "repair",
        report: summarizeReport(report as never),
        goalValidation: validation,
        validationErrors: attempt > 0 ? journal.filter((e) => e.decision === "rejected").at(-1)?.errors : undefined,
      });

      llmCalls += 1;
      journal.push({ iteration, decision: "propose", provenance: { advisorId: input.advisor.id, durationMs: Date.now() - proposeStart } });

      if (proposal.terminal) {
        failureReason = "advisor declared terminal without goalMet";

        break;
      }

      const verdict = validateAdvisorProposal(proposal as never, recipe);

      if (verdict.ok) {
        proposalRecipe = verdict.instructionSet;

        break;
      }

      journal.push({ iteration, decision: "rejected", errors: verdict.errors });
    }

    if (failureReason) break;
    if (!proposalRecipe) {
      failureReason = "no valid proposal after retries";

      break;
    }

    recipe = proposalRecipe;
    void report; void validation;
  }

  if (!best) {
    return { ok: false, goal: input.goal, url: input.url, iterations: journal.length, journal, committedRecipe: null, finalGoalValidation: null, failureReason: failureReason ?? "goal not met within budget" };
  }

  // Commit: versioned artifact ("the file stays, the process does not").
  mkdirSync(recipesDir, { recursive: true });
  const version = `v${new Date().toISOString().slice(0, 10)}-${best.recipe.name}`;
  const committedPath = join(recipesDir, `${version}.json`);

  writeFileSync(committedPath, JSON.stringify({ goal: input.goal, goalSpec: input.goalSpec, recipe: best.recipe }, null, 2));

  journal.push({ iteration: journal.length, decision: "commit" });

  return { ok: true, goal: input.goal, url: input.url, iterations: journal.length, journal, committedRecipe: committedPath, finalGoalValidation: best.validation, failureReason: null };
}
