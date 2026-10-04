import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  InstructionSetSchema,
  BrowserCrawlerConfigSchema,
  DEFAULT_BROWSER_CRAWLER_CONFIG,
} from "../contracts";
import { validateParsedJson as validateInstructionSet, parseInstructionInput, sha256Of } from "./validate";
import { loadConfig } from "../config/loader";

const VALID = {
  name: "fixture-recipe",
  steps: [
    { label: "open", action: "open", url: "https://example.org/calendar" },
    { action: "extract", itemSelector: "article", fields: [{ name: "title", selector: "h3", as: "text" }], jsonLd: true },
    { action: "done", success: true },
  ],
};

describe("instruction schema", () => {
  it("accepts the valid set and yields a deterministic runId", () => {
    // SAFETY: VALID is a schema-shaped literal owned by this test.
    const a = validateInstructionSet(VALID);
    // SAFETY: shape guaranteed by the owning boundary above.
    const b = validateInstructionSet(JSON.parse(JSON.stringify(VALID)));

    expect(a.instructionSet.steps).toHaveLength(3);
    expect(a.runId).toBe(b.runId);
    expect(a.runId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects unknown actions, bad bounds, seq mismatches, and traversal artifacts", () => {
    // SAFETY: shape guaranteed by the owning boundary above.
    expect(() => validateInstructionSet({ name: "xx", steps: [{ action: "teleport" }] })).toThrow();
    // SAFETY: shape guaranteed by the owning boundary above.
    expect(() => validateInstructionSet({ name: "xx", steps: [{ action: "scroll", amount: 99 }] })).toThrow();
    // SAFETY: shape guaranteed by the owning boundary above.
    expect(() => validateInstructionSet({ name: "xx", steps: [{ action: "wait", for: { timeMs: 999999 } }] })).toThrow();
    // SAFETY: shape guaranteed by the owning boundary above.
    expect(() => validateInstructionSet({ name: "xx", steps: [{ action: "screenshot", artifact: "..\/..\/etc\/passwd" }] })).toThrow();
    // SAFETY: shape guaranteed by the owning boundary above.
    expect(() => validateInstructionSet({ name: "xx", steps: [{ seq: 7, action: "done", success: true }] })).toThrow(/seq/);
  });

  it("parses JSONL with comments", () => {
    const set = parseInstructionInput('// hi\n{"action":"open","url":"https://example.org/"}\n{"action":"done","success":true}');

    expect(set.steps).toHaveLength(2);
  });
});

describe("config loader", () => {
  it("defaults validate; politeness keys are frozen against recipe overrides", () => {
    expect([...Value.Errors(BrowserCrawlerConfigSchema, DEFAULT_BROWSER_CRAWLER_CONFIG)]).toHaveLength(0);

    expect(() => loadConfig(undefined, { politeness: { minIntervalPerDomainMs: 10 } })).toThrow(/frozen/);
    expect(() => loadConfig(undefined, { politeness: { maxPagesPerDomainPerRun: 5 } })).not.toThrow();
  });

  it("deep-merges non-frozen keys", () => {
    const config = loadConfig(undefined, { viewport: { height: 1024 } });

    expect(config.viewport.height).toBe(1024);
    expect(config.viewport.width).toBe(DEFAULT_BROWSER_CRAWLER_CONFIG.viewport.width);
  });
});

describe("cassette keying", () => {
  it("runId changes with instructions; config hash changes with config", () => {
    // SAFETY: canonical-hash inputs are JSON literals owned by this test.
    const a = sha256Of(VALID);
    const variant = { ...VALID, steps: VALID.steps.slice(0, 2) };

    expect(sha256Of(variant)).not.toBe(a);
    expect(sha256Of({ locale: "en" })).not.toBe(sha256Of({ locale: "cs" }));
  });
});
