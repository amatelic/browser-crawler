/**
 * Config loader: file/env/defaults precedence, deep merge, and the frozen
 * politeness guard (recipe-level overrides of politeness keys are validation
 * errors, not silent clamps). All untrusted JSON narrows through type
 * predicates and the TypeBox validator at this single boundary.
 */

import { readFileSync } from "node:fs";
import { Value } from "@sinclair/typebox/value";
import {
  BrowserCrawlerConfigSchema,
  DEFAULT_BROWSER_CRAWLER_CONFIG,
  type BrowserCrawlerConfig,
} from "../contracts";

/** Recursive owner model for untrusted config JSON (feeds.ts pattern). */
type ConfigValue = string | number | boolean | null | ConfigOverride | ConfigValue[];

export interface ConfigOverride {
  [key: string]: ConfigValue;
}

type OverrideValue = ConfigValue | undefined;

function isConfigOverride(value: unknown): value is ConfigOverride {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberValue(value: OverrideValue): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function applyOverride(base: ConfigOverride, override: ConfigOverride): void {
  for (const [key, value] of Object.entries(override)) {
    if (key === "politeness") {
      applyPolitenessOverride(base, value);
      continue;
    }

    const baseValue: OverrideValue | undefined = base[key];

    if (isConfigOverride(baseValue) && isConfigOverride(value)) {
      applyOverride(baseValue, value);
      continue;
    }

    base[key] = value;
  }
}

/** Politeness is engine-frozen; only maxPagesPerDomainPerRun may DECREASE. */
function applyPolitenessOverride(base: ConfigOverride, value: OverrideValue): void {
  if (!isConfigOverride(value)) {
    throw new Error("config key 'politeness' must be an object");
  }

  const politeness: ConfigOverride = isConfigOverride(base.politeness) ? base.politeness : {};

  for (const [pk, pv] of Object.entries(value)) {
    if (pk === "maxPagesPerDomainPerRun" && isNumberValue(pv)) {
      const currentMax = isNumberValue(politeness.maxPagesPerDomainPerRun)
        ? politeness.maxPagesPerDomainPerRun
        : 100;

      politeness.maxPagesPerDomainPerRun = Math.min(currentMax, Math.max(1, Math.floor(pv)));
      base.politeness = politeness;
      continue;
    }

    throw new Error(`config key 'politeness.${pk}' is engine-frozen and cannot be overridden`);
  }
}

export function loadConfig(path?: string, override?: ConfigOverride): BrowserCrawlerConfig {
  const merged: ConfigOverride = { ...DEFAULT_BROWSER_CRAWLER_CONFIG };

  const effectivePath = path ?? process.env.BROWSER_CRAWLER_CONFIG;

  if (effectivePath) {
    // SAFETY: JSON.parse output is narrowed through isConfigOverride and
    // the TypeBox validator below before any consumer reads a field.
    // SAFETY: JSON.parse output narrows via isConfigOverride then TypeBox.
    const parsed: unknown = JSON.parse(readFileSync(effectivePath, "utf8"));

    // SAFETY: unknown JSON narrows through the predicate before merge.
    if (isConfigOverride(parsed)) applyOverride(merged, parsed);
  }

  if (override) applyOverride(merged, override);

  if (!Value.Check(BrowserCrawlerConfigSchema, merged)) {
    const first = [...Value.Errors(BrowserCrawlerConfigSchema, merged)][0];

    throw new Error(`invalid browser-crawler config: ${first?.path}: ${first?.message}`);
  }

  return Value.Decode(BrowserCrawlerConfigSchema, merged);
}

export { applyOverride as deepMerge };
