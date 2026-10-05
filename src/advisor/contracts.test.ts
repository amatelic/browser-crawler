import { describe, expect, it } from "vitest";
import {
  applyPatch,
  evaluateGoal,
  summarizeReport,
  validateAdvisorProposal,
  type AdvisorProposal,
} from "./contracts";
import type { InstructionSet } from "../contracts";

const BASE: InstructionSet = {
  name: "demo",
  steps: [
    { action: "open", url: "https://example.org/calendar" },
    { action: "done", success: true },
  ],
} as InstructionSet;

describe("evaluateGoal (pure reward)", () => {
  it("minRows + fill ratio + pattern rule + uniqueness", () => {
    const rows = [
      { title: "A", url: "https://x.org/1", date: "2026-11-01" },
      { title: "B", url: "https://x.org/2", date: "2026-11-02" },
      { title: "", url: "https://x.org/1", date: "2026-11-03" },
    ];
    const result = evaluateGoal(
      {
        minRows: 2,
        requiredFields: ["title", "url"],
        fieldRules: [{ field: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }],
        uniqueness: ["url"],
        maxEmptyFieldRatio: 0.34,
      },
      { rows },
    );

    expect(result.checks.find((c) => c.id === "minRows")?.pass).toBe(true);
    expect(result.checks.find((c) => c.id === "fill:title")?.pass).toBe(true); // 2/3 filled ≥ 1-0.34
    expect(result.checks.find((c) => c.id === "rule:date")?.pass).toBe(true);
    expect(result.checks.find((c) => c.id === "unique:url")?.pass).toBe(false); // dupe url
    expect(result.goalMet).toBe(false);
    expect(result.score).toBe(0.8); // 4/5: url fills 3/3, only unique:url fails
  });

  it("empty goal is trivially met; zero rows fails explicit criteria", () => {
    expect(evaluateGoal({}, { rows: [] }).goalMet).toBe(true);
    expect(evaluateGoal({ minRows: 1 }, { rows: [] }).goalMet).toBe(false);
  });
});

describe("validateAdvisorProposal (the chokepoint)", () => {
  it("accepts a clean full-recipe proposal", () => {
    const proposal: AdvisorProposal = {
      kind: "full-recipe",
      recipe: { ...BASE, steps: [...BASE.steps] },
      rationale: "open and finish",
      confidence: 0.8,
    };

    const verdict = validateAdvisorProposal(proposal, BASE);

    expect(verdict.ok).toBe(true);
  });

  it("REJECTS proposals whose recipe embeds config (host authority)", () => {
    const proposal = {
      kind: "full-recipe",
      recipe: { ...BASE, config: { allowlist: { domains: ["evil.example"] } } },
      rationale: "tries to widen the allowlist",
      confidence: 0.9,
    };

    const verdict = validateAdvisorProposal(proposal as never, BASE);

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.errors.join(" ")).toContain("config block");
  });

  it("rejects unsafe selectors (control chars / unicode escapes)", () => {
    const proposal = {
      kind: "full-recipe",
      recipe: {
        name: "bad",
        steps: [{ action: "click", target: { selector: "a[href=\"\\\\u003cscript\\u003e\"]\n" } }],
      },
      rationale: "x",
      confidence: 0.5,
    };

    const verdict = validateAdvisorProposal(proposal as never, BASE);

    expect(verdict.ok === false && verdict.errors.join(" ")).toMatch(/unsafe selector|schema/);
  });

  it("aggregates errors and applies patches by seq", () => {
    const patch = {
      kind: "patch",
      patch: {
        replace: [{ seq: 2, step: { action: "done", success: true, note: "patched" } }],
        insertAfter: [{ seq: 1, steps: [{ action: "wait", for: { selector: "article" } }] }],
      },
      rationale: "fix step 2",
      confidence: 0.7,
    };

    const verdict = validateAdvisorProposal(patch as never, BASE);

    expect(verdict.ok).toBe(true);

    if (verdict.ok) {
      expect(verdict.instructionSet.steps).toHaveLength(3);
      expect(verdict.instructionSet.steps[1]?.action).toBe("wait");
    }

    const badPatch = { ...patch, patch: { replace: [{ seq: 99, step: { action: "done", success: true } }] } };
    const bad = validateAdvisorProposal(badPatch as never, BASE);

    expect(bad.ok).toBe(false);
  });
});

describe("applyPatch", () => {
  it("remove + insertAfter compose positionally", () => {
    const next = applyPatch(BASE, { remove: [2], insertAfter: [{ seq: 1, steps: [{ action: "back" }] }] });

    expect(next.steps.map((s) => s.action)).toEqual(["open", "back"]);
  });
});

describe("summarizeReport (redactor)", () => {
  it("never leaks render bodies or network payloads", () => {
    const summary = summarizeReport({
      ok: true,
      runId: "r1",
      render: { finalUrl: "https://x.org/", httpStatus: 200, body: "SECRET PAGE CONTENT" },
      steps: [{ seq: 1, action: "open", status: "ok", ms: 5 }],
      extracted: { rows: [{ title: "Event", url: "https://x.org/e1" }], links: [1], jsonLd: [{}], network: [{ secret: "token" }] },
      politeness: { domainHits: { "x.org": 1 } },
      failureReason: null,
    });

    const json = JSON.stringify(summary);

    expect(json).not.toContain("SECRET");
    expect(json).not.toContain("token");
    expect(summary.extracted.rowCount).toBe(1);
    expect(summary.extracted.sampleRows[0]?.title).toBe("Event");
  });
});
