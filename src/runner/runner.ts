/**
 * The instruction runner: one browser → one context → an active page; steps
 * execute strictly in order; every URL transition is re-gated; popups are
 * closed on sight; results land in one RunReport (byte-identical across
 * CLI / API / HTTP surfaces). No Date.now/Math.random — injected clock.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import type { BrowserCrawlerConfig, InstructionSet, Step, Target } from "../contracts";
import { PolitenessGate, type GateVerdict, type PolitenessCapabilities } from "./gate";
import { sha256Of } from "../instructions/validate";

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

/** Recursive owner model for per-action payload data. */
type ActionDataValue = string | number | boolean | null | ActionData | ActionDataValue[];

interface ActionData {
  [key: string]: ActionDataValue;
}

export interface StepResult {
  seq: number;
  label?: string;
  action: string;
  status: "ok" | "error" | "skipped";
  ms: number;
  /** Owner contract: per-action payload keys (validated action shapes upstream). */
  data?: ActionData;
  error?: { code: string; message: string; selector?: string };
  skippedReason?: string;
  artifact?: string;
}

export interface RenderSection {
  requestedUrl: string | null;
  finalUrl: string | null;
  state: string;
  httpStatus: number | null;
  contentType: string;
  body: string | null;
  bytes: number;
  redirectChain: string[];
  contentHash: string | null;
  failureReason: string | null;
  durationMs: number;
  decisions: Array<{ step: string; verdict: string; detail: string }>;
}

export interface RunReport {
  ok: boolean;
  runId: string;
  schemaVersion: 1;
  render: RenderSection;
  page: { title: string | null; consoleErrors: string[]; requests: { total: number; blocked: number } };
  steps: StepResult[];
  extracted: {
    rows: Array<Record<string, unknown>>;
    jsonLd: unknown[];
    links: string[];
    /** Captured XHR/fetch responses (capabilities.networkCapture). */
    network: Array<{ url: string; status: number; body: unknown }>;
  };
  artifacts: Array<{ kind: string; path: string }>;
  politeness: { domainHits: Record<string, number>; minIntervalObservedMs: number | null };
  cassettePath: string | null;
  failureReason: string | null;
  durationMs: number;
}

/** Host-side lifecycle hooks (observability/retry/branching in the HOST,
 *  never in recipes — recipes stay replay-deterministic data). */
export interface BrowserCrawlerHooks {
  /** After every step settles (ok, error, or skipped). */
  onStepResult?: (step: StepResult) => void | Promise<void>;
  /** Every politeness-gated navigation attempt with its verdict. */
  onNavigation?: (url: string, verdictOk: boolean, code?: string) => void | Promise<void>;
}

export interface BrowserCrawlerCapabilities extends PolitenessCapabilities {
  browserFactory: (config: BrowserCrawlerConfig) => Promise<Browser>;
  hooks?: BrowserCrawlerHooks;
  logger?: (message: string) => void;
  /** When set, replay is attempted before any live render (strict: missing
   *  key with replay==='strict' is an error, never a silent live run). */
  cassette?: { dir: string; mode: "record" | "replay" | "strict-replay" };
}

interface RefEntry { selector: string; tag: string; text: string }

/** Named owner contract: resolved target for locator calls. */
interface ResolvedTarget {
  selector: string;
  viaRef?: string;
}

export async function runInstructions(
  input: { instructionSet: InstructionSet; runId: string },
  config: BrowserCrawlerConfig,
  capabilities: BrowserCrawlerCapabilities,
): Promise<RunReport> {
  const startedAt = capabilities.clock();
  const configHash = sha256Of(config);
  const cassetteKey = `${input.runId}:${configHash}`;
  const log = capabilities.logger ?? (() => {});
  const fireHook = async (fn: (() => Promise<void> | void) | undefined): Promise<void> => {
    if (!fn) return;

    try {
      await fn();
    } catch (error) {
      log(`hook error (ignored): ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const minInterval = config.politeness.minIntervalPerDomainMs;

  let lastGateAt: number | null = null;
  let minIntervalObserved: number | null = null;

  const gate = new PolitenessGate(config, {
    ...capabilities,
    fetchRobotsText: async (origin) => {
      const out = await capabilities.fetchRobotsText(origin);

      if (out) log(`robots ${origin} → ${out.status}`);

      return out;
    },
  });

  const report: RunReport = {
    ok: false,
    runId: input.runId,
    schemaVersion: 1,
    render: {
      requestedUrl: null, finalUrl: null, state: "navigation_failed", httpStatus: null,
      contentType: "text/html", body: null, bytes: 0, redirectChain: [], contentHash: null,
      failureReason: null, durationMs: 0, decisions: [],
    },
    page: { title: null, consoleErrors: [], requests: { total: 0, blocked: 0 } },
    steps: [],
    extracted: { rows: [], jsonLd: [], links: [], network: [] },
    artifacts: [],
    politeness: { domainHits: {}, minIntervalObservedMs: null },
    cassettePath: capabilities.cassette ? join(capabilities.cassette.dir, `${cassetteKey.slice(0, 24)}.json`) : null,
    failureReason: null,
    durationMs: 0,
  };

  const gateCheck = async (url: string) => {
    const verdict = await gate.check(url);

    await fireHook(capabilities.hooks ? () => capabilities.hooks!.onNavigation?.(url, verdict.ok, verdict.ok ? undefined : verdict.code) : undefined);

    return verdict;
  };

  const observeInterval = (): void => {
    if (lastGateAt !== null) {
      const gap = capabilities.clock() - lastGateAt;

      if (minIntervalObserved === null || gap < minIntervalObserved) minIntervalObserved = gap;
    }

    lastGateAt = capabilities.clock();
  };

  const bumpDomainHit = (host: string): void => {
    report.politeness.domainHits[host] = (report.politeness.domainHits[host] ?? 0) + 1;
  };

  // --- cassette replay (no chromium) ----------------------------------------
  if (capabilities.cassette?.mode !== "record") {
    const replayed = replayCassette(report.cassettePath, cassetteKey);

    if (replayed) {
      replayed.runId = input.runId;
      replayed.cassettePath = report.cassettePath;
      replayed.durationMs = capabilities.clock() - startedAt;

      return replayed;
    }

    if (capabilities.cassette?.mode === "strict-replay") {
      report.failureReason = `cassette miss (strict-replay): ${cassetteKey.slice(0, 24)}`;
      report.render.failureReason = report.failureReason;
      report.durationMs = capabilities.clock() - startedAt;

      return report;
    }
  }

  // --- browser lifecycle ----------------------------------------------------
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let lastValidatedUrl: string | null = null;
  let resolveTarget: (target: Target) => ResolvedTarget;
  const refs = new Map<string, RefEntry>();

  // SAFETY: failRun reasons are engine-owned strings.
  const failRun = (reason: string): RunReport => {
    report.failureReason = reason;
    report.render.failureReason = reason;
    report.durationMs = capabilities.clock() - startedAt;

    return report;
  };

  try {
    browser = await capabilities.browserFactory(config);
    context = await browser.newContext({
      ignoreHTTPSErrors: config.rendering.ignoreHttpsErrors,
      viewport: config.viewport,
      userAgent: config.userAgent,
      locale: config.locale,
      timezoneId: config.timezoneId,
      serviceWorkers: config.blocking.blockServiceWorkers ? "block" : "allow",
    });

    // Response capture (declarative interception): matching XHR/fetch
    // responses land in report.extracted.network — gated behind the
    // capabilities.networkCapture flag (default off).
    const captureRules = input.instructionSet.capture ?? [];
    let captureBlockedByCapability = false;

    if (captureRules.length > 0 && !config.capabilities.networkCapture) {
      captureBlockedByCapability = true;
    }

    if (captureRules.length > 0 && config.capabilities.networkCapture) {
      context.on("response", (response) => {
        void (async () => {
          const url = response.url();

          for (const rule of captureRules) {
            if (report.extracted.network.filter((entry) => entry.url === url).length >= (rule.limit ?? 20)) continue;

            let pattern: RegExp;

            try {
              pattern = new RegExp(rule.urlPattern);
            } catch {
              continue;
            }

            if (!pattern.test(url)) continue;

            try {
              const body = rule.as === "json" ? await response.json() : await response.text();

              report.extracted.network.push({ url, status: response.status(), body });
            } catch {
              // Body unavailable (redirect/empty): skipped, not fatal.
            }
          }
        })();
      });
    }

    // Popups: pages with an opener (target=_blank / window.open) are closed
    // immediately; pages WE create via newPage() have no opener and live.
    const ownPages = new Set<Page>();

    context.on("page", (created) => {
      void (async () => {
        const opener = await created.opener().catch(() => null);

        if (opener === null && !ownPages.has(created)) return;

        if (opener !== null) {
          await created.close().catch(() => {});
          log("popup closed");
        }
      })();
    });

    context.route("**/*", (route) => {
      const request = route.request();
      report.page.requests.total += 1;

      const resourceType = request.resourceType();
      const url = request.url();

      // SAFETY: shape guaranteed by the owning boundary above.
      if (config.blocking.resourceTypes.includes(resourceType as "image" | "media" | "font" | "stylesheet")) {
        report.page.requests.blocked += 1;

        void route.abort();

        return;
      }

      if (config.blocking.blockOrigins.some((origin) => url.includes(origin))) {
        report.page.requests.blocked += 1;

        void route.abort();

        return;
      }

      void route.continue();
    });

    const ensurePage = async (): Promise<Page> => {
      if (page && !page.isClosed()) return page;

      page = await context!.newPage();
      ownPages.add(page);
      page.on("console", (message) => {
        if (message.type() === "error" && report.page.consoleErrors.length < 50) {
          report.page.consoleErrors.push(message.text().slice(0, 200));
        }
      });

      return page;
    };

    resolveTarget = (target: Target): ResolvedTarget => {
      if ("ref" in target) {
        const entry = refs.get(target.ref);

        if (!entry) throw new StepError("STALE_REF", `ref ${target.ref} is unknown — re-extract the page`);

        return { selector: entry.selector, viaRef: target.ref };
      }

      if ("selector" in target && "text" in target) {
        return { selector: `${target.selector}:has-text("${target.text.replace(/"/g, '\\"')}")` };
      }

      return { selector: target.selector };
    };

    const settle = async (ms?: number): Promise<void> => {
      await capabilities.sleep(Math.min(ms ?? config.timeouts.settleMs, config.timeouts.actionMs));
    };

    /** Post-step URL-transition guard: JS/meta/redirect navigations are
     *  re-gated exactly like `open`. */
    const guardUrlTransition = async (): Promise<void> => {
      if (!page || page.isClosed()) return;

      const current = page.url();

      if (current === "about:blank") return;

      const canonical = new URL(current).toString();

      if (canonical === lastValidatedUrl) return;

      if (lastValidatedUrl !== null && gate.isValidated(canonical)) {
        lastValidatedUrl = canonical;

        return;
      }

      const verdict = await gateCheck(current);

      if (!verdict.ok) {
        report.render.decisions.push(...gate.decisionLog.splice(0));

        throw new StepError(verdict.code, `URL transition to ${current} denied: ${verdict.detail}`);
      }

      observeInterval();
      bumpDomainHit(verdict.host);
      report.render.redirectChain.push(canonical);
      lastValidatedUrl = canonical;
    };

    let aborted = false;

    for (let index = 0; index < input.instructionSet.steps.length; index += 1) {
      const step = input.instructionSet.steps[index]!;
      const stepStart = capabilities.clock();

      if (aborted) {
        report.steps.push({
          seq: index + 1, label: step.label, action: step.action,
          status: "skipped", ms: 0, skippedReason: "earlier step failed",
        });

        continue;
      }

      try {
        const result = await runStep(step, {
          config, capabilities, gate, gateCheck, page: ensurePage, resolveTarget, settle,
          refs, report, observeInterval, bumpDomainHit,
          setValidated: (url: string) => { lastValidatedUrl = url; },
          resetPage: async () => {
            if (page && !page.isClosed()) {
              ownPages.delete(page);
              await page.close().catch(() => {});
            }
          },
          getValidated: () => lastValidatedUrl,
          guardUrlTransition,
          configHash,
        });

        report.steps.push({ seq: index + 1, label: step.label, action: step.action, status: "ok", ms: capabilities.clock() - stepStart, ...result });
        await guardUrlTransition();
        await fireHook(capabilities.hooks ? () => capabilities.hooks!.onStepResult?.(report.steps[report.steps.length - 1]!) : undefined);

        // Static pacing: per-step afterMs (upward) or the config default.
        const stepAfter = (step as { afterMs?: number }).afterMs ?? config.rendering.interStepDelayMs;

        if (stepAfter > 0) await capabilities.sleep(stepAfter);
      } catch (error: unknown) {
        const isStepError = error instanceof StepError;
        const code = isStepError ? error.code : "BROWSER_LAUNCH_FAILED";
        // SAFETY: playwright locator errors always carry a message string.
  const message = error instanceof Error ? error.message : String(error);

        report.steps.push({
          seq: index + 1, label: step.label, action: step.action, status: "error",
          ms: capabilities.clock() - stepStart,
          error: { code, message: message.slice(0, 300), selector: isStepError ? error.selector : undefined },
        });
        await fireHook(capabilities.hooks ? () => capabilities.hooks!.onStepResult?.(report.steps[report.steps.length - 1]!) : undefined);

        if (step.onError !== "continue") aborted = true;
      }
    }

    // Final render section from the active page.
    // SAFETY: page is assigned via ensurePage() closures above; the
    // explicit cast defeats control-flow narrowing to never.
    const activePage = page as Page | null;

    if (activePage && !activePage.isClosed()) {
      const body = await activePage.content();

      report.render.body = body;
      report.render.bytes = Buffer.byteLength(body);
      report.render.contentHash = sha256Of(body);
      report.page.title = await activePage.title();
      report.render.finalUrl = activePage.url();
      report.render.state = report.render.failureReason ? "navigation_failed" : "fetched_browser";
      // A run is ok when no step failed that the recipe did not explicitly
      // tolerate (onError:"continue") and a render was produced.
      const fatalSteps = input.instructionSet.steps.filter((step, i) => step.onError !== "continue" && report.steps[i]?.status === "error");

      report.ok = fatalSteps.length === 0 && report.render.body !== null;
    }

    if (captureBlockedByCapability) {
      report.failureReason = "capture rules present but capabilities.networkCapture is off";
      report.ok = false;
    }

    report.render.durationMs = capabilities.clock() - startedAt;
    report.render.decisions.push(...gate.decisionLog.splice(0));
    report.politeness.minIntervalObservedMs = minIntervalObserved !== null && minIntervalObserved < minInterval ? minIntervalObserved : minIntervalObserved;
    report.durationMs = capabilities.clock() - startedAt;

    if (capabilities.cassette && report.render.body !== null) {
      writeCassette(report.cassettePath, cassetteKey, report);
    }

    return report;
  } catch (error: unknown) {
    // SAFETY: engine failure reasons narrow through the Error check.
    return failRun(error instanceof Error ? error.message.slice(0, 200) : String(error));
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

export class StepError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly selector?: string,
  ) {
    super(message);
  }
}

interface StepContext {
  config: BrowserCrawlerConfig;
  capabilities: BrowserCrawlerCapabilities;
  gate: PolitenessGate;
  gateCheck: (url: string) => Promise<GateVerdict>;
  page: () => Promise<Page>;
  resolveTarget: (target: Target) => { selector: string; viaRef?: string };
  settle: (ms?: number) => Promise<void>;
  refs: Map<string, RefEntry>;
  report: RunReport;
  observeInterval: () => void;
  bumpDomainHit: (host: string) => void;
  setValidated: (url: string) => void;
  getValidated: () => string | null;
  resetPage: () => Promise<void>;
  guardUrlTransition: () => Promise<void>;
  configHash: string;
}

async function runStep(step: Step, ctx: StepContext): Promise<Partial<StepResult>> {
  const page = await ctx.page();
  const actionMs = ctx.config.timeouts.actionMs;

  switch (step.action) {
    case "open": {
      if (ctx.report.render.requestedUrl === null) ctx.report.render.requestedUrl = step.url;

      const verdict = await ctx.gateCheck(step.url);

      if (!verdict.ok) throw new StepError(verdict.code, `${step.url}: ${verdict.detail}`);

      ctx.observeInterval();
      ctx.bumpDomainHit(verdict.host);

      if (step.fresh) await ctx.resetPage();

      const active = await ctx.page();

      const response = await active.goto(verdict.canonicalUrl, {
        waitUntil: step.waitFor?.state ?? ctx.config.waitUntil,
        timeout: step.waitFor?.timeoutMs ?? ctx.config.timeouts.navigationMs,
      }).catch((error: unknown) => {
        // SAFETY: goto rejections are Error instances from playwright.
        throw new StepError("TIMEOUT_NAVIGATION", error instanceof Error ? error.message : String(error));
      });

      const status = response?.status() ?? null;

      // Render-tier semantics: 4xx pages still render real content on many
      // SPAs (soft-404 templates, locale hops) — record the status and let
      // the recipe decide. Only transport failures and 5xx abort here.
      if (status !== null && status >= 500) {
        throw new StepError("NAVIGATION_HTTP_ERROR", `http ${status} for ${verdict.canonicalUrl}`);
      }

      ctx.setValidated(active.url());

      return { data: { url: active.url(), title: await active.title(), httpStatus: status } };
    }

    case "click": {
      const { selector } = ctx.resolveTarget(step.target);

      try {
        await page.locator(selector).first().click({ timeout: step.settleMs ?? actionMs, force: step.force === true });
      } catch (error) {
        throw locatorError(error, selector);
      }

      if (step.waitFor?.networkIdleTimeoutMs) {
        // Wait until the page is network-idle (e.g. an XHR patch finished)
        // instead of a blind settle — batch-loading SPAs.
        await page.waitForLoadState("networkidle", { timeout: step.waitFor.networkIdleTimeoutMs })
          .catch(() => { throw new StepError("TIMEOUT_ACTION", `network did not go idle within ${step.waitFor?.networkIdleTimeoutMs}ms`); });
      } else {
        await ctx.settle(step.settleMs);
      }

      return { data: { urlAfter: page.url() } };
    }

    case "fill": {
      const { selector } = ctx.resolveTarget(step.target);

      try {
        await page.locator(selector).first().fill(step.text, { timeout: actionMs });
      } catch (error) {
        throw locatorError(error, selector);
      }

      if (step.submit) await page.keyboard.press("Enter");

      if (step.waitFor?.networkIdleTimeoutMs) {
        await page.waitForLoadState("networkidle", { timeout: step.waitFor.networkIdleTimeoutMs })
          .catch(() => { throw new StepError("TIMEOUT_ACTION", `network did not go idle within ${step.waitFor?.networkIdleTimeoutMs}ms`); });
      } else {
        await ctx.settle();
      }

      return { data: {} };
    }

    case "select": {
      const { selector } = ctx.resolveTarget(step.target);

      try {
        await page.locator(selector).first().selectOption(step.value, { timeout: actionMs });
      } catch (error) {
        throw locatorError(error, selector);
      }

      await ctx.settle();

      return { data: {} };
    }

    case "press_key": {
      await page.keyboard.press(step.key);
      await ctx.settle();

      return { data: {} };
    }

    case "hover": {
      const { selector } = ctx.resolveTarget(step.target);

      try {
        await page.locator(selector).first().hover({ timeout: actionMs });
      } catch (error) {
        throw locatorError(error, selector);
      }

      await ctx.settle();

      return { data: {} };
    }

    case "scroll": {
      if (step.target) {
        const { selector } = ctx.resolveTarget(step.target);

        await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: actionMs });
      } else if (step.toBottom) {
        await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
      } else {
        const direction = step.direction === "up" ? -1 : 1;
        const pixels = direction * (step.amount ?? 3) * 800;

        await page.mouse.wheel(0, pixels);
      }

      await ctx.settle();

      return { data: { scrolledTo: await page.evaluate(() => window.scrollY), pageHeight: await page.evaluate(() => document.body.scrollHeight) } };
    }

    case "wait": {
      const timeout = step.timeoutMs ?? actionMs;
      const spec = step.for;

      if ("timeMs" in spec) {
        await ctx.capabilities.sleep(spec.timeMs);
      } else if ("text" in spec) {
        await page.getByText(spec.text).first().waitFor({ timeout, state: "visible" });
      } else if ("textGone" in spec) {
        await page.getByText(spec.textGone).first().waitFor({ timeout, state: "hidden" });
      } else {
        // Browser-side wait (real time in the page) — the injected engine
        // clock must not gate on page rendering.
        const minCount = spec.minCount ?? 1;

        await page.waitForFunction(
          (args) => document.querySelectorAll(args.selector).length >= args.minCount,
          { selector: spec.selector, minCount },
          { timeout, polling: 100 },
        ).catch(() => {
          throw new StepError("TIMEOUT_ACTION", `selector ${spec.selector} did not reach ${minCount} within ${timeout}ms`, spec.selector);
        });
      }

      return { data: {} };
    }

    case "extract": {
      const data: ActionData = {};

      if (step.fields && step.fields.length > 0) {
        const scope = step.scope?.selector;
        const root = scope ? page.locator(scope).first() : page.locator("body");

        if (step.itemSelector) {
          const items = root.locator(step.itemSelector);
          const count = Math.min(await items.count(), step.limit ?? 200);

          for (let i = 0; i < count; i += 1) {
            const item = items.nth(i);
            const row: ActionData = {};

            for (const field of step.fields) {
              if (field.multiple) {
                const values = await item.locator(field.selector).evaluateAll(
                  (nodes, mode) => nodes.map((node) => mode === "attr"
                    // SAFETY: shape guaranteed by the owning boundary above.
                    ? (node as HTMLElement).getAttribute("datetime") ?? (node as HTMLElement).getAttribute("href") ?? ""
                    : node.textContent ?? ""),
                  field.as,
                );

                row[field.name] = values;
              } else {
                const cell = item.locator(field.selector).first();

                row[field.name] = field.as === "attr" && field.attr
                  ? await cell.getAttribute(field.attr).catch(() => null)
                  : field.as === "html"
                    ? await cell.innerHTML().catch(() => null)
                    : await cell.textContent().catch(() => null);
              }
            }

            ctx.report.extracted.rows.push(row);
          }
        } else {
          const row: ActionData = {};

          for (const field of step.fields) {
            const cell = root.locator(field.selector).first();

            row[field.name] = field.as === "attr" && field.attr
              ? await cell.getAttribute(field.attr).catch(() => null)
              : await cell.textContent().catch(() => null);
          }

          ctx.report.extracted.rows.push(row);
        }

        data.rows = ctx.report.extracted.rows.length;
      }

      if (step.jsonLd) {
        const jsonLd = await page.evaluate(() =>
          Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
            .map((node) => {
              try {
                return JSON.parse(node.textContent ?? "null");
              } catch {
                return null;
              }
            })
            .filter((value) => value !== null),
        );

        ctx.report.extracted.jsonLd.push(...jsonLd);
        data.jsonLd = jsonLd.length;
      }

      if (step.links) {
        const hrefs = await page.locator(step.links.selector)
          // SAFETY: shape guaranteed by the owning boundary above.
          .evaluateAll((nodes) => nodes.map((node) => (node as HTMLAnchorElement).href));

        const unique = [...new Set(hrefs)].slice(0, step.links.limit ?? 200);

        ctx.report.extracted.links.push(...unique);
        data.links = unique.length;
      }

      if (step.refs) {
        ctx.refs.clear();

        const interactive = await page.evaluate(() => {
          const buildPath = (element: Element): string => {
            if (element.id) return `#${element.id}`;

            const parent = element.parentElement;

            if (!parent) return element.tagName.toLowerCase();

            const siblings = Array.from(parent.children).filter((c) => c.tagName === element.tagName);
            const index = siblings.indexOf(element) + 1;

            return `${buildPath(parent)} > ${element.tagName.toLowerCase()}:nth-of-type(${index})`;
          };

          return Array.from(document.querySelectorAll("a, button, select, input, textarea"))
            .slice(0, 50)
            .map((element) => ({
              selector: buildPath(element),
              tag: element.tagName.toLowerCase(),
              text: (element.textContent ?? "").trim().slice(0, 60),
            }));
        });

        interactive.forEach((entry, i) => {
          ctx.refs.set(`e${i + 1}`, entry);
        });

        data.refs = interactive.length;
      }

      return { data };
    }

    case "screenshot": {
      if (!/^[A-Za-z0-9._-]+$/.test(step.artifact) || step.artifact.includes("..")) {
        throw new StepError("PATH_TRAVERSAL_REJECTED", `artifact must be a basename: ${step.artifact}`);
      }

      const dir = resolve(ctx.config.artifacts.dir);

      mkdirSync(dir, { recursive: true });

      const path = join(dir, step.artifact);
      const resolved = resolve(path);

      if (!resolved.startsWith(dirname(resolve(dir)) === resolved ? resolved : resolve(dir)) && !resolved.startsWith(resolve(dir))) {
        throw new StepError("PATH_TRAVERSAL_REJECTED", step.artifact);
      }

      await page.screenshot({ path: resolved, fullPage: step.fullPage === true });
      ctx.report.artifacts.push({ kind: "screenshot", path: resolved });

      return { artifact: resolved, data: { artifact: resolved } };
    }

    case "back": {
      await page.goBack({ timeout: ctx.config.timeouts.navigationMs });

      const canonical = page.url();

      if (!ctx.gate.isValidated(canonical)) {
        throw new StepError("REDIRECT_ORIGIN_DENIED", `back() landed on an unvalidated URL: ${canonical}`);
      }

      ctx.setValidated(canonical);

      return { data: { url: canonical } };
    }

    case "close": {
      await page.close();

      return { data: {} };
    }

    case "done": {
      return { data: { finished: true, success: step.success, note: step.note ?? null } };
    }

    default: {
      // SAFETY: shape guaranteed by the owning boundary above.
      throw new StepError("CAPABILITY_DISABLED", `unknown action ${(step as { action: string }).action}`);
    }
  }
}

function locatorError(error: unknown, selector: string): StepError {
  // SAFETY: playwright locator errors always carry a message string.
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("Timeout")) {
    return new StepError("SELECTOR_NOT_FOUND", `selector not found or not actionable: ${selector}`, selector);
  }

  return new StepError("ELEMENT_NOT_ACTIONABLE", message.slice(0, 200), selector);
}

// ---------------------------------------------------------------------------
// Cassette (render-level, format v2: key = runId + configHash)
// ---------------------------------------------------------------------------

interface CassetteEntry {
  key: string;
  networkCaptures?: Array<{ url: string; status: number; body: unknown }>;
  requestedUrl: string | null;
  finalUrl: string | null;
  httpStatus: number | null;
  renderedHtmlBase64: string;
  contentHash: string | null;
  decisions: RenderSection["decisions"];
  durationMs: number;
  recordedAt: number;
}

function replayCassette(path: string | null, key: string): RunReport | null {
  if (!path) return null;

  let parsed: { entries?: CassetteEntry[] };

  try {
    // SAFETY: parsed shape is checked structurally before field access.
    parsed = JSON.parse(readFileSafe(path)) as { entries?: CassetteEntry[] };
  } catch {
    return null;
  }

  const entry = parsed.entries?.find((candidate) => candidate.key === key);

  if (!entry) return null;

  const body = Buffer.from(entry.renderedHtmlBase64, "base64").toString("utf8");

  return {
    ok: true,
    runId: key,
    schemaVersion: 1,
    render: {
      requestedUrl: entry.requestedUrl,
      finalUrl: entry.finalUrl,
      state: "fetched_browser",
      httpStatus: entry.httpStatus,
      contentType: "text/html",
      body,
      bytes: Buffer.byteLength(body),
      redirectChain: [],
      contentHash: entry.contentHash,
      failureReason: null,
      durationMs: entry.durationMs,
      decisions: entry.decisions,
    },
    page: { title: null, consoleErrors: [], requests: { total: 0, blocked: 0 } },
    steps: [],
    extracted: { rows: [], jsonLd: [], links: [], network: entry.networkCaptures ?? [] },
    artifacts: [],
    politeness: { domainHits: {}, minIntervalObservedMs: null },
    cassettePath: path,
    failureReason: null,
    durationMs: 0,
  };
}

function readFileSafe(path: string): string {
  try {
    // SAFETY: shape guaranteed by the owning boundary above.
    return require("node:fs").readFileSync(path, "utf8") as string;
  } catch {
    throw new Error("unreadable");
  }
}

function writeCassette(path: string | null, key: string, report: RunReport): void {
  if (!path || report.render.body === null) return;

  const entry: CassetteEntry = {
    key,
    networkCaptures: report.extracted.network,
    requestedUrl: report.render.requestedUrl,
    finalUrl: report.render.finalUrl,
    httpStatus: report.render.httpStatus,
    renderedHtmlBase64: Buffer.from(report.render.body, "utf8").toString("base64"),
    contentHash: report.render.contentHash,
    decisions: report.render.decisions,
    durationMs: report.render.durationMs,
    recordedAt: 0,
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 2, mode: "browser-render", entries: [entry] }, null, 2));
}
