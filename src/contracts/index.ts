/**
 * Browser-crawler protocol contracts (ExecPlan browser-crawler, v0.1).
 *
 * The declarative instruction protocol, config schema, and report shape that
 * agents, the CLI, and the HTTP surface all share. Kept free of any
 * playwright imports so lightweight consumers (planners, tool registries)
 * can link against the contracts alone. The engine re-exports these from
 * its index for convenience.
 *
 * Design provenance: Anthropic browser toolset, playwright-mcp, browser-use,
 * Steel/Browserbase session surfaces; adversarially verified 2026-10-04
 * (corrections applied: skipped rows carry a reason, artifact names are
 * basenames only, refs are page-level, text matching is substring).
 */

import { Type, type Static } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Targeting (dual addressing; coordinates deliberately absent)
// ---------------------------------------------------------------------------

export const TargetSchema = Type.Union(
  [
    Type.Object({ selector: Type.String({ minLength: 1, maxLength: 300 }) }),
    Type.Object({ ref: Type.String({ minLength: 1, maxLength: 16 }) }),
    Type.Object({
      selector: Type.String({ minLength: 1, maxLength: 300 }),
      text: Type.String({ minLength: 1, maxLength: 200 }),
    }),
  ],
  { $id: "BrowserCrawlerTarget" },
);

export type Target = Static<typeof TargetSchema>;

// ---------------------------------------------------------------------------
// Steps: 13-action discriminated union (v0.1)
// ---------------------------------------------------------------------------

/** Extra real-time pause after a step completes (static pacing). */
const AfterMs = Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000 }));

const Label = Type.Optional(Type.String({ maxLength: 120 }));
const OnError = Type.Optional(Type.Union([Type.Literal("abort"), Type.Literal("continue")]));
const WaitFor = Type.Optional(
  Type.Object({
    state: Type.Union([
      Type.Literal("load"),
      Type.Literal("domcontentloaded"),
      Type.Literal("networkidle"),
    ]),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 250, maximum: 60_000 })),
  }),
);

/** Artifact names are BASENAMES only (path traversal rejected at validation). */
const ArtifactName = Type.String({
  minLength: 1,
  maxLength: 120,
  pattern: "^[A-Za-z0-9._-]+$",
});

export const ExtractFieldSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 60 }),
  selector: Type.String({ minLength: 1, maxLength: 300 }),
  as: Type.Union([Type.Literal("text"), Type.Literal("attr"), Type.Literal("html")]),
  attr: Type.Optional(Type.String({ maxLength: 60 })),
  multiple: Type.Optional(Type.Boolean()),
});

export const StepSchema = Type.Union(
  [
    Type.Object({
      label: Label,
      action: Type.Literal("open"),
      url: Type.String({ minLength: 8, maxLength: 2000 }),
      waitFor: WaitFor,
      fresh: Type.Optional(Type.Boolean()),
      afterMs: AfterMs,
      onError: OnError,
    }),
    Type.Object({
      label: Label,
      action: Type.Literal("click"),
      target: TargetSchema,
      settleMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
      /** Settle only once the page is network-idle (XHR batches loaded). */
      waitFor: Type.Optional(Type.Object({
        networkIdleTimeoutMs: Type.Integer({ minimum: 500, maximum: 30_000 }),
      })),
      force: Type.Optional(Type.Boolean()),
      afterMs: AfterMs,
      onError: OnError,
    }),
    Type.Object({
      label: Label,
      action: Type.Literal("fill"),
      target: TargetSchema,
      text: Type.String({ maxLength: 500 }),
      submit: Type.Optional(Type.Boolean()),
      waitFor: Type.Optional(Type.Object({
        networkIdleTimeoutMs: Type.Integer({ minimum: 500, maximum: 30_000 }),
      })),
      afterMs: AfterMs,
      onError: OnError,
    }),
    Type.Object({
      label: Label,
      action: Type.Literal("select"),
      target: TargetSchema,
      value: Type.Union([Type.String({ maxLength: 300 }), Type.Array(Type.String({ maxLength: 300 }), { maxItems: 20 })]),
      onError: OnError,
    }),
    Type.Object({
      label: Label,
      action: Type.Literal("press_key"),
      key: Type.String({ minLength: 1, maxLength: 40 }),
      onError: OnError,
    }),
    Type.Object({
      label: Label,
      action: Type.Literal("hover"),
      target: TargetSchema,
      onError: OnError,
    }),
    Type.Object({
      label: Label,
      action: Type.Literal("scroll"),
      direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down")])),
      /** Wheel-notches 1–10 (mapped to 800px per notch in the runner). */
      amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      toBottom: Type.Optional(Type.Boolean()),
      target: Type.Optional(TargetSchema),
      onError: OnError,
    }),
    Type.Object({
      label: Label,
      action: Type.Literal("wait"),
      for: Type.Union([
        Type.Object({ timeMs: Type.Integer({ minimum: 0, maximum: 30_000 }) }),
        Type.Object({ text: Type.String({ minLength: 1, maxLength: 200 }) }),
        Type.Object({ textGone: Type.String({ minLength: 1, maxLength: 200 }) }),
        Type.Object({
          selector: Type.String({ minLength: 1, maxLength: 300 }),
          minCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
        }),
      ]),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 250, maximum: 30_000 })),
      afterMs: AfterMs,
      onError: OnError,
    }),
    Type.Object({
      label: Label,
      action: Type.Literal("extract"),
      scope: Type.Optional(Type.Object({ selector: Type.String({ minLength: 1, maxLength: 300 }) })),
      itemSelector: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      fields: Type.Optional(Type.Array(ExtractFieldSchema, { maxItems: 40 })),
      jsonLd: Type.Optional(Type.Boolean()),
      links: Type.Optional(
        Type.Object({
          selector: Type.String({ minLength: 1, maxLength: 300 }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
        }),
      ),
      /** Refs are PAGE-level interactive elements (never item rows). */
      refs: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      onError: OnError,
    }),
    Type.Object({
      label: Label,
      action: Type.Literal("screenshot"),
      artifact: ArtifactName,
      fullPage: Type.Optional(Type.Boolean()),
      target: Type.Optional(TargetSchema),
      onError: OnError,
    }),
    Type.Object({ label: Label, action: Type.Literal("back"), onError: OnError }),
    Type.Object({ label: Label, action: Type.Literal("close"), onError: OnError }),
    Type.Object({
      label: Label,
      action: Type.Literal("done"),
      success: Type.Boolean(),
      note: Type.Optional(Type.String({ maxLength: 300 })),
      onError: OnError,
    }),
  ],
  { $id: "BrowserCrawlerStep" },
);

export type Step = Static<typeof StepSchema>;
export type StepAction = Step["action"];

export const CaptureRuleSchema = Type.Object({
  urlPattern: Type.String({ minLength: 3, maxLength: 300 }),
  as: Type.Union([Type.Literal("json"), Type.Literal("text")]),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const InstructionSetSchema = Type.Object(
  {
    name: Type.String({ minLength: 2, maxLength: 80, pattern: "^[a-z0-9-]+$" }),
    config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    /** XHR/fetch response capture (requires capabilities.networkCapture). */
    capture: Type.Optional(Type.Array(CaptureRuleSchema, { maxItems: 10 })),
    steps: Type.Array(StepSchema, { minItems: 1, maxItems: 200 }),
  },
  { $id: "BrowserCrawlerInstructionSet" },
);

export type InstructionSet = Static<typeof InstructionSetSchema>;

// ---------------------------------------------------------------------------
// Config (validated at startup; politeness keys are frozen)
// ---------------------------------------------------------------------------

export const BrowserCrawlerConfigSchema = Type.Object({
  viewport: Type.Object({
    width: Type.Integer({ minimum: 320, maximum: 3840 }),
    height: Type.Integer({ minimum: 240, maximum: 2160 }),
  }),
  userAgent: Type.String({ minLength: 10, maxLength: 300 }),
  locale: Type.String({ minLength: 2, maxLength: 10 }),
  timezoneId: Type.String({ minLength: 2, maxLength: 60 }),
  headless: Type.Boolean(),
  waitUntil: Type.Union([
    Type.Literal("load"),
    Type.Literal("domcontentloaded"),
    Type.Literal("networkidle"),
  ]),
  timeouts: Type.Object({
    navigationMs: Type.Integer({ minimum: 1000, maximum: 120_000 }),
    actionMs: Type.Integer({ minimum: 250, maximum: 60_000 }),
    settleMs: Type.Integer({ minimum: 0, maximum: 5000 }),
  }),
  maxRedirects: Type.Integer({ minimum: 1, maximum: 20 }),
  /** Frozen: recipe/step overrides on these keys are validation errors. */
  politeness: Type.Object({
    robotsMode: Type.Literal("fail-closed"),
    minIntervalPerDomainMs: Type.Integer({ minimum: 500, maximum: 60_000 }),
    maxPagesPerDomainPerRun: Type.Integer({ minimum: 1, maximum: 100 }),
    respectCrawlDelay: Type.Boolean(),
  }),
  allowlist: Type.Object({
    domains: Type.Array(Type.String({ minLength: 3, maxLength: 200 }), { minItems: 0 }),
  }),
  blocking: Type.Object({
    resourceTypes: Type.Array(
      Type.Union([
        Type.Literal("image"),
        Type.Literal("media"),
        Type.Literal("font"),
        Type.Literal("stylesheet"),
      ]),
      { maxItems: 4 },
    ),
    blockOrigins: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 50 }),
    blockServiceWorkers: Type.Boolean(),
  }),
  rendering: Type.Object({
    slowMoMs: Type.Integer({ minimum: 0, maximum: 5000 }),
    idleTimeoutMs: Type.Integer({ minimum: 10_000, maximum: 600_000 }),
    /** Static pause after every step (recipe afterMs overrides upward). */
    interStepDelayMs: Type.Integer({ minimum: 0, maximum: 30_000 }),
    /** Opt-in for hosts with incomplete certificate chains (praha.eu):
     *  skips TLS verification in the RENDER context only — allowlist,
     *  SSRF, and robots gates still apply. Default false. */
    ignoreHttpsErrors: Type.Boolean(),
  }),
  session: Type.Object({
    storageStatePath: Type.Union([Type.String({ maxLength: 400 }), Type.Null()]),
    reuseSessionAcrossSteps: Type.Boolean(),
  }),
  capabilities: Type.Object({
    javascriptEval: Type.Boolean(),
    networkCapture: Type.Boolean(),
  }),
  artifacts: Type.Object({
    dir: Type.String({ maxLength: 300 }),
    saveTrace: Type.Boolean(),
    maxBytesPerRun: Type.Integer({ minimum: 1_048_576, maximum: 524_288_000 }),
  }),
});

export type BrowserCrawlerConfig = Static<typeof BrowserCrawlerConfigSchema>;

export const DEFAULT_BROWSER_CRAWLER_CONFIG: BrowserCrawlerConfig = {
  viewport: { width: 1366, height: 768 },
  userAgent: "Mozilla/5.0 (compatible; nomadia-browser-renderer/0.1)",
  locale: "en-GB",
  timezoneId: "Europe/Prague",
  headless: true,
  waitUntil: "domcontentloaded",
  timeouts: { navigationMs: 60_000, actionMs: 5000, settleMs: 500 },
  maxRedirects: 10,
  politeness: {
    robotsMode: "fail-closed",
    minIntervalPerDomainMs: 2000,
    maxPagesPerDomainPerRun: 25,
    respectCrawlDelay: true,
  },
  allowlist: { domains: [] },
  blocking: {
    resourceTypes: ["image", "media", "font"],
    blockOrigins: ["googletagmanager.com", "doubleclick.net"],
    blockServiceWorkers: true,
  },
  rendering: { slowMoMs: 0, idleTimeoutMs: 300_000, interStepDelayMs: 0, ignoreHttpsErrors: false },
  session: { storageStatePath: null, reuseSessionAcrossSteps: true },
  capabilities: { javascriptEval: false, networkCapture: false },
  artifacts: { dir: "out/browser", saveTrace: true, maxBytesPerRun: 52_428_800 },
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const BROWSER_CRAWLER_ERROR_CODES = [
  "SELECTOR_NOT_FOUND",
  "STALE_REF",
  "TIMEOUT_NAVIGATION",
  "TIMEOUT_ACTION",
  "ELEMENT_NOT_ACTIONABLE",
  "ROBOTS_DISALLOWED",
  "ROBOTS_FAIL_CLOSED",
  "SSRF_BLOCKED",
  "REDIRECT_ORIGIN_DENIED",
  "DOMAIN_NOT_ALLOWED",
  "BUDGET_EXHAUSTED",
  "NAVIGATION_HTTP_ERROR",
  "ARTIFACT_WRITE_FAILED",
  "PATH_TRAVERSAL_REJECTED",
  "BROWSER_LAUNCH_FAILED",
  "SCHEME_NOT_ALLOWED",
  "CAPABILITY_DISABLED",
  "VALIDATION_FAILED",
] as const;

export type BrowserCrawlerErrorCode = (typeof BROWSER_CRAWLER_ERROR_CODES)[number];

/** Render state mirrors the static fetcher vocabulary plus the browser tier. */
export const BROWSER_CRAWLER_FETCH_STATES = [
  "fetched_browser",
  "robots_blocked",
  "ssrf_blocked",
  "budget_exhausted",
  "http_error",
  "navigation_failed",
] as const;

export type BrowserFetchState = (typeof BROWSER_CRAWLER_FETCH_STATES)[number];
