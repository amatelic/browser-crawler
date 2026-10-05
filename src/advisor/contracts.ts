/**
 * Advisor contracts: how models (a local decision model or an
 * OpenAI-compatible LLM) integrate at the HOST layer — never inside the
 * engine, never inside recipes.
 *
 * Invariants enforced here:
 * - Model output is ALWAYS candidate data (a recipe or patch) that must
 *   pass validateAdvisorProposal before anything runs.
 * - Proposals carry STEPS ONLY: any proposal whose recipe embeds a config
 *   block is rejected outright (config is the host's authority — a model
 *   must never widen the allowlist or touch politeness/session).
 * - Goal validation is a pure function over report.extracted — no clock,
 *   no fetch, no model — so it is replay-deterministic and can never widen
 *   the fetch envelope.
 *
 * This module has ZERO model dependencies and never names other packages
 * (boundary scanners keep it green in every host repo).
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { InstructionSet, Step } from "../contracts";
import { validateInstructionSet } from "../instructions/validate";

// ---------------------------------------------------------------------------
// Bounded decision surface (choice / noul / score + ABSTAIN)
// ---------------------------------------------------------------------------

export interface AdvisorChoiceQuestion {
  id: string;
  kind: "choice";
  prompt: string;
  options: readonly string[];
  descriptions?: Record<string, string>;
}

export interface AdvisorNoulQuestion {
  id: string;
  kind: "noul";
  prompt: string;
}

export interface AdvisorScoreQuestion {
  id: string;
  kind: "score";
  prompt: string;
  levels: readonly string[];
}

export type AdvisorQuestion =
  | AdvisorChoiceQuestion
  | AdvisorNoulQuestion
  | AdvisorScoreQuestion;

export type AdvisorAnswer =
  | { kind: "choice"; id: string; choice: string; confidence: number; probabilities: Record<string, number> }
  | { kind: "noul"; id: string; answer: boolean; probability: number; confidence: number }
  | { kind: "score"; id: string; score: number; normalized: number; level: string; confidence: number }
  | { kind: "abstain"; id: string; reason: string };

/** Confidence gates: below the gate, out-of-options, or schema-invalid
 *  ⇒ ABSTAIN. Abstain is "no signal", never permission. */
export const ADVISOR_DECISION_GATES = { choice: 0.6, noul: 0.6, score: 0.7 } as const;

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export interface RecipeAdvisor {
  /** Stable id recorded in provenance, e.g. "llm-openai-compat:glm-4.6". */
  readonly id: string;
  readonly capabilities: { propose: boolean; decide: boolean };
  /** Author/repair: observation → candidate recipe data. Expensive; rare. */
  propose?(observation: AdvisorObservation): Promise<AdvisorProposal>;
  /** Bounded arbitration: calibrated answers. Cheap. */
  decide?(state: string, questions: readonly AdvisorQuestion[]): Promise<AdvisorAnswer[]>;
}

// ---------------------------------------------------------------------------
// Observation in (redacted, size-capped)
// ---------------------------------------------------------------------------

export interface DomHint {
  selector: string;
  tag: string;
  text: string;
  candidates?: string[];
}

export interface RunReportSummary {
  ok: boolean;
  runId: string;
  finalUrl: string | null;
  httpStatus: number | null;
  steps: Array<{
    seq: number;
    label?: string;
    action: string;
    status: "ok" | "error" | "skipped";
    error?: { code: string; message?: string };
    ms: number;
  }>;
  extracted: {
    rowCount: number;
    fieldNames: string[];
    sampleRows: Array<Record<string, string>>;
    linkCount: number;
    jsonLdCount: number;
    networkCaptureCount: number;
  };
  politeness: { domainHits: Record<string, number> };
  failureReason: string | null;
}

export interface AdvisorObservation {
  goal: string;
  url: string;
  iteration: number;
  mode: "author" | "repair";
  report: RunReportSummary;
  goalValidation: GoalValidation;
  domHints?: DomHint[];
  validationErrors?: string[];
}

// ---------------------------------------------------------------------------
// Proposal out (data only; never executed before validation)
// ---------------------------------------------------------------------------

export interface RecipePatch {
  replace?: Array<{ seq: number; step: Step }>;
  insertAfter?: Array<{ seq: number; steps: Step[] }>;
  remove?: number[];
}

export interface AdvisorProposal {
  kind: "full-recipe" | "patch";
  recipe?: InstructionSet;
  patch?: RecipePatch;
  rationale: string;
  confidence: number;
  terminal?: boolean;
}

export const AdvisorProposalSchema = Type.Object({
  kind: Type.Union([Type.Literal("full-recipe"), Type.Literal("patch")]),
  recipe: Type.Optional(Type.Unknown()),
  patch: Type.Optional(Type.Unknown()),
  rationale: Type.String({ maxLength: 500 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  terminal: Type.Optional(Type.Boolean()),
});

export type ProposalVerdict =
  | { ok: true; instructionSet: InstructionSet }
  | { ok: false; errors: string[] };

/** Selector lint: a conservative CSS subset — no control characters, no
 *  unicode escapes, nothing that could smuggle executable content. */
// No backslash at all: blocks unicode escapes and control smuggles;
// CSS rarely needs escapes — recipes can always use plain selectors.
const SAFE_SELECTOR = /^[A-Za-z0-9 _\-.#:,>*~+=()[\]"'|^$]+$/;

function selectorOf(step: Step): string[] {
  const target = (step as { target?: { selector?: unknown } }).target;
  const scope = (step as { scope?: { selector?: unknown } }).scope;
  const item = (step as { itemSelector?: unknown }).itemSelector;
  const links = (step as { links?: { selector?: unknown } }).links;
  const wait = (step as { for?: { selector?: unknown } }).for;

  return [target?.selector, scope?.selector, item, links?.selector, wait?.selector]
    .filter((value): value is string => typeof value === "string");
}

/** The single validation chokepoint for ALL model output. Aggregates every
 *  failure so a rejection is fully journaled on the first bounce. */
export function validateAdvisorProposal(
  proposal: AdvisorProposal,
  current: InstructionSet,
): ProposalVerdict {
  const errors: string[] = [];
  let candidate: InstructionSet;

  if (proposal.kind === "full-recipe") {
    if (!proposal.recipe) {
      return { ok: false, errors: ["full-recipe proposal carries no recipe"] };
    }

    // HARD RULE: proposals carry steps only. A config block in a proposal
    // is a model trying to touch host authority (allowlist, session,
    // capabilities, politeness) — rejected outright.
    if (proposal.recipe.config !== undefined) {
      errors.push("proposal recipe embeds a config block — config is host authority; proposals carry steps only");
    }

    candidate = proposal.recipe;
  } else {
    if (!proposal.patch) {
      return { ok: false, errors: ["patch proposal carries no patch"] };
    }

    try {
      candidate = applyPatch(current, proposal.patch);
    } catch (error) {
      return { ok: false, errors: [`patch application failed: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }

  // Schema validation (the existing boundary) — aggregated, not first-throw.
  try {
    validateInstructionSet(candidate as never);
  } catch (error) {
    errors.push(`schema validation: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Selector lint over every step.
  for (const step of candidate.steps) {
    for (const selector of selectorOf(step)) {
      if (!SAFE_SELECTOR.test(selector)) {
        errors.push(`unsafe selector on step ${(step as { action: string }).action}: ${selector.slice(0, 60)}`);
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, instructionSet: candidate };
}

/** Apply a step-indexed patch to a validated recipe. Seq discipline is
 *  enforced (1-based positions must exist; inserts bounded). */
export function applyPatch(current: InstructionSet, patch: RecipePatch): InstructionSet {
  const steps = [...current.steps];

  for (const { seq, step } of patch.replace ?? []) {
    if (seq < 1 || seq > steps.length) throw new Error(`replace: no step at seq ${seq}`);

    steps[seq - 1] = step;
  }

  for (const seq of patch.remove ?? []) {
    if (seq < 1 || seq > steps.length) throw new Error(`remove: no step at seq ${seq}`);
  }

  const removeSet = new Set(patch.remove ?? []);

  const kept = steps.filter((_, i) => !removeSet.has(i + 1));

  for (const { seq, steps: inserted } of (patch.insertAfter ?? []).slice().sort((a, b) => b.seq - a.seq)) {
    if (seq < 0 || seq > kept.length) throw new Error(`insertAfter: invalid seq ${seq}`);

    kept.splice(seq, 0, ...inserted);
  }

  return { ...current, steps: kept };
}

// ---------------------------------------------------------------------------
// Goal validation — the deterministic reward (pure over extracted)
// ---------------------------------------------------------------------------

export interface GoalSpec {
  minRows?: number;
  requiredFields?: string[];
  fieldRules?: Array<{ field: string; pattern: string }>;
  maxEmptyFieldRatio?: number;
  uniqueness?: string[];
}

export const GoalSpecSchema = Type.Object({
  minRows: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
  requiredFields: Type.Optional(Type.Array(Type.String({ maxLength: 60 }), { maxItems: 20 })),
  fieldRules: Type.Optional(Type.Array(
    Type.Object({ field: Type.String({ maxLength: 60 }), pattern: Type.String({ maxLength: 200 }) }),
    { maxItems: 20 },
  )),
  maxEmptyFieldRatio: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  uniqueness: Type.Optional(Type.Array(Type.String({ maxLength: 60 }), { maxItems: 10 })),
});

export interface GoalValidation {
  goalMet: boolean;
  score: number;
  checks: Array<{ id: string; pass: boolean; detail: string }>;
}

/** Pure evaluation over extracted rows. No clock, no fetch, no model. */
export function evaluateGoal(
  goal: GoalSpec,
  extracted: { rows: Array<Record<string, unknown>> },
): GoalValidation {
  const checks: GoalValidation["checks"] = [];
  const rows = extracted.rows;

  if (goal.minRows !== undefined) {
    checks.push({
      id: "minRows",
      pass: rows.length >= goal.minRows,
      detail: `${rows.length} rows ${rows.length >= goal.minRows ? "≥" : "<"} ${goal.minRows}`,
    });
  }

  if (goal.requiredFields && goal.requiredFields.length > 0) {
    for (const field of goal.requiredFields) {
      const filled = rows.filter((row) => {
        const value = row[field];

        return typeof value === "string" ? value.trim().length > 0 : value != null;
      }).length;

      const ratio = rows.length === 0 ? 0 : filled / rows.length;

      checks.push({
        id: `fill:${field}`,
        pass: rows.length > 0 && ratio >= 1 - (goal.maxEmptyFieldRatio ?? 0),
        detail: rows.length === 0 ? "no rows" : `${filled}/${rows.length} filled (${ratio.toFixed(2)})`,
      });
    }
  }

  for (const rule of goal.fieldRules ?? []) {
    let compiled: RegExp;

    try {
      compiled = new RegExp(rule.pattern);
    } catch {
      checks.push({ id: `rule:${rule.field}`, pass: false, detail: `invalid pattern: ${rule.pattern}` });

      continue;
    }

    const valid = rows.filter((row) => {
      const value = row[rule.field];

      return typeof value === "string" && compiled.test(value);
    }).length;

    checks.push({
      id: `rule:${rule.field}`,
      pass: rows.length > 0 && valid === rows.length,
      detail: rows.length === 0 ? "no rows" : `${valid}/${rows.length} match`,
    });
  }

  for (const field of goal.uniqueness ?? []) {
    const values = rows.map((row) => String(row[field] ?? ""));
    const unique = new Set(values).size;

    checks.push({
      id: `unique:${field}`,
      pass: unique === values.length,
      detail: `${unique} unique / ${values.length} rows`,
    });
  }

  if (checks.length === 0) {
    return { goalMet: true, score: 1, checks: [{ id: "noop", pass: true, detail: "no goal criteria" }] };
  }

  const passed = checks.filter((c) => c.pass).length;

  return { goalMet: passed === checks.length, score: passed / checks.length, checks };
}

export function validateGoalSpec(input: unknown): GoalSpec {
  if (!Value.Check(GoalSpecSchema, input)) {
    const first = [...Value.Errors(GoalSpecSchema, input)][0];

    throw new Error(`invalid goal spec at ${first?.path}: ${first?.message}`);
  }

  return Value.Decode(GoalSpecSchema, input);
}

// ---------------------------------------------------------------------------
// Deterministic redactor: RunReport → model-safe summary
// ---------------------------------------------------------------------------

interface RedactableReport {
  ok: boolean;
  runId: string;
  render?: { finalUrl?: string | null; httpStatus?: number | null; body?: unknown };
  steps?: Array<{ seq: number; label?: string; action: string; status: string; error?: { code: string; message?: string }; ms: number }>;
  extracted?: {
    rows?: Array<Record<string, unknown>>;
    links?: unknown[];
    jsonLd?: unknown[];
    network?: unknown[];
  };
  politeness?: { domainHits?: Record<string, number> };
  failureReason?: string | null;
}

export function summarizeReport(report: RedactableReport): RunReportSummary {
  const rows = report.extracted?.rows ?? [];
  const fieldNames = rows.length > 0 ? Object.keys(rows[0] ?? {}) : [];

  return {
    ok: report.ok,
    runId: report.runId,
    finalUrl: report.render?.finalUrl ?? null,
    httpStatus: report.render?.httpStatus ?? null,
    steps: (report.steps ?? []).map((step) => ({
      seq: step.seq,
      label: step.label,
      action: step.action,
      status: step.status as "ok" | "error" | "skipped",
      error: step.error ? { code: step.error.code, message: (step.error.message ?? "").slice(0, 120) } : undefined,
      ms: step.ms,
    })),
    extracted: {
      rowCount: rows.length,
      fieldNames,
      sampleRows: rows.slice(0, 3).map((row) => {
        const sample: Record<string, string> = {};

        for (const key of Object.keys(row)) {
          sample[key] = String(row[key] ?? "").slice(0, 80);
        }

        return sample;
      }),
      linkCount: report.extracted?.links?.length ?? 0,
      jsonLdCount: report.extracted?.jsonLd?.length ?? 0,
      networkCaptureCount: report.extracted?.network?.length ?? 0,
    },
    politeness: { domainHits: report.politeness?.domainHits ?? {} },
    failureReason: report.failureReason ?? null,
  };
}
