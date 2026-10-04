/**
 * Politeness gate: every navigation transition passes
 * scheme → allowlist → canonicalize → SSRF (pre-resolved DNS) → robots
 * (fail-closed) → per-domain rate spacing → per-domain page budget.
 * Browsers auto-follow redirects and JS can navigate — so the gate also runs
 * on EVERY observed URL transition (per-step page.url() diff) and popups are
 * closed on sight.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import type { BrowserCrawlerConfig } from "../contracts";
import { RobotsCache, type RobotsFetchOutcome } from "../politeness/robots";
import { DomainRateLimiter } from "../politeness/rate-limiter";
import { allAddressesAllowed } from "../politeness/ssrf";
import { canonicalUrlString, hostKey } from "../politeness/url-policy";

export type GateVerdict =
  | { ok: true; canonicalUrl: string; host: string }
  | { ok: false; code: string; detail: string };

export interface PolitenessCapabilities {
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  fetchRobotsText: (origin: string) => Promise<RobotsFetchOutcome | null>;
  dnsLookup?: (hostname: string) => Promise<string[]>;
  /** Test-only escape hatch for the loopback fixture server. */
  allowLoopback?: boolean;
}

/** Longest-prefix disallow with allow override — identical semantics to
 *  the static fetcher's matcher so both tiers behave the same on the same
 *  robots.txt. */
function isPathDisallowed(pathname: string, rules: { allow: string[]; disallow: string[] }): boolean {
  let bestDisallow: string | null = null;

  for (const prefix of rules.disallow) {
    if (prefix && pathname.startsWith(prefix)) {
      if (bestDisallow === null || prefix.length > bestDisallow.length) bestDisallow = prefix;
    }
  }

  if (bestDisallow === null) return false;

  let bestAllow: string | null = null;

  for (const prefix of rules.allow) {
    if (prefix && pathname.startsWith(prefix)) {
      if (bestAllow === null || prefix.length > bestAllow.length) bestAllow = prefix;
    }
  }

  return bestAllow === null || bestAllow.length < bestDisallow.length;
}

export class PolitenessGate {
  private readonly robots: RobotsCache;
  private readonly limiter: DomainRateLimiter;
  private readonly pagesPerDomain = new Map<string, number>();
  private readonly validatedUrls = new Set<string>();

  constructor(
    private readonly config: BrowserCrawlerConfig,
    private readonly capabilities: PolitenessCapabilities,
  ) {
    this.robots = new RobotsCache({
      fetchRobotsText: capabilities.fetchRobotsText,
      clock: capabilities.clock,
      ttlMs: 60_000,
    });
    this.limiter = new DomainRateLimiter({
      minIntervalMsPerDomain: config.politeness.minIntervalPerDomainMs,
      backoffBaseMs: 2_000,
      maxBackoffMs: 30_000,
      breakerThreshold: 4,
      breakerCooldownMs: 30_000,
      clock: capabilities.clock,
      sleep: capabilities.sleep,
    });
  }

  decisionLog: Array<{ step: string; verdict: string; detail: string }> = [];

  async check(rawUrl: string): Promise<GateVerdict> {
    // 1. Scheme: only http(s).
    if (!/^https?:\/\//i.test(rawUrl)) {
      return { ok: false, code: "SCHEME_NOT_ALLOWED", detail: rawUrl.slice(0, 80) };
    }

    const canonical = canonicalUrlString(rawUrl);

    if (!canonical) {
      return { ok: false, code: "SCHEME_NOT_ALLOWED", detail: "uncanonicalizable url" };
    }

    let parsed: URL;

    try {
      parsed = new URL(canonical);
    } catch {
      return { ok: false, code: "SCHEME_NOT_ALLOWED", detail: canonical.slice(0, 80) };
    }

    // 2. Allowlist: deny-by-default for browser navigation.
    const host = parsed.hostname.toLowerCase();

    const allowed = this.config.allowlist.domains.some(
      (d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`),
    );

    if (!allowed && !(this.capabilities.allowLoopback === true && (host === "127.0.0.1" || host === "localhost"))) {
      this.decisionLog.push({ step: "allowlist", verdict: "deny", detail: host });

      return { ok: false, code: "DOMAIN_NOT_ALLOWED", detail: host };
    }

    // 3. SSRF: pre-resolve DNS (chromium resolves internally — this must
    //    happen before goto).
    try {
      const resolve = this.capabilities.dnsLookup ?? ((h: string) => dnsLookup(h, { all: true }).then((a) => a.map((x) => x.address)));
      const addresses = await resolve(parsed.hostname);

      if (!allAddressesAllowed(addresses, { allowLoopback: this.capabilities.allowLoopback === true })) {
        this.decisionLog.push({ step: "ssrf", verdict: "deny", detail: parsed.hostname });

        return { ok: false, code: "SSRF_BLOCKED", detail: parsed.hostname };
      }
    } catch {
      this.decisionLog.push({ step: "ssrf_dns", verdict: "deny", detail: parsed.hostname });

      return { ok: false, code: "SSRF_BLOCKED", detail: `dns lookup failed: ${parsed.hostname}` };
    }

    // 4. Robots: fail-closed (fetch error / 5xx ⇒ deny; 404/absent ⇒ allow).
    const info = await this.robots.get(parsed.origin);

    if (info.failClosed) {
      this.decisionLog.push({ step: "robots", verdict: "deny", detail: `${parsed.origin} robots unreachable (fail-closed)` });

      return { ok: false, code: "ROBOTS_FAIL_CLOSED", detail: parsed.origin };
    }

    if (info.rules !== null) {
      // Same literal-prefix semantics as the static tier's matcher
      // (fetcher.ts isPathAllowedForAgent): longest disallow wins, allow
      // overrides. Patterns match as written — splitting on '*' would turn
      // '/*/x' rules into a blanket '/' disallow (bug found live on praha.eu).
      const disallowed = isPathDisallowed(parsed.pathname, info.rules);

      if (disallowed) {
        this.decisionLog.push({ step: "robots", verdict: "deny", detail: `${parsed.pathname} disallowed` });

        return { ok: false, code: "ROBOTS_DISALLOWED", detail: parsed.pathname };
      }
    }

    // 5. Rate spacing per domain (may sleep).
    await this.limiter.acquire(hostKey(parsed), {
      minIntervalMs: this.config.politeness.respectCrawlDelay && info.rules?.crawlDelaySeconds
        ? Math.max(info.rules.crawlDelaySeconds * 1000, this.config.politeness.minIntervalPerDomainMs)
        : undefined,
    });

    // 6. Page budget per domain per run.
    const key = hostKey(parsed);
    const used = this.pagesPerDomain.get(key) ?? 0;

    if (used >= this.config.politeness.maxPagesPerDomainPerRun) {
      this.decisionLog.push({ step: "budget", verdict: "deny", detail: `${key} ${used}/${this.config.politeness.maxPagesPerDomainPerRun}` });

      return { ok: false, code: "BUDGET_EXHAUSTED", detail: key };
    }

    this.pagesPerDomain.set(key, used + 1);
    this.validatedUrls.add(canonical);
    this.decisionLog.push({ step: "gate", verdict: "allow", detail: canonical.slice(0, 90) });

    return { ok: true, canonicalUrl: canonical, host };
  }

  /** A URL is safe to *be on* if it was validated this run. */
  isValidated(canonicalUrl: string): boolean {
    return this.validatedUrls.has(canonicalUrl);
  }
}
