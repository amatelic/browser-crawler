/**
 * Vendored from the knowledge-crawler engine's retrieval layer (identical
 * semantics; golden tests kept in sync). PR0 promotes this kernel to
 * a shared politeness package and remove the duplication.
 */

/**
 * robots.txt policy (architecture §4.17, §13).
 *
 * Deterministic parser + matcher + TTL cache. Semantics:
 * - Matching: longest-prefix rule wins; on equal length, Allow wins (Google
 *   convention). An empty `Disallow:` allows everything.
 * - HTTP 404 / absent robots.txt → crawling allowed (standard convention).
 * - Fetch error or 5xx → FAIL CLOSED (disallow everything) for that origin
 *   until the cache entry expires. The crawler never politeness-guesses.
 * - Crawl-delay (seconds) is exposed to the rate limiter by the gateway.
 *
 * The cache is transport-agnostic: the caller injects `fetchRobotsText`
 * (the gateway provides the SSRF-safe fetch; tests provide fixtures).
 */

export const KNOWLEDGE_USER_AGENT_TOKEN = "nomadia-knowledge-crawler";

export interface RobotsRules {
  allow: string[];
  disallow: string[];
  crawlDelaySeconds: number | null;
}

export interface RobotsInfo {
  origin: string;
  /** null = no robots.txt found (404) → everything allowed. */
  rules: RobotsRules | null;
  /** Fail-closed marker: robots wanted but unreadable. */
  failClosed: boolean;
  sitemaps: string[];
  fetchedAt: number;
}

export interface ParsedRobots {
  groups: Map<string, RobotsRules>;
  sitemaps: string[];
}

export function parseRobotsTxt(text: string): ParsedRobots {
  const groups = new Map<string, RobotsRules>();
  const sitemaps: string[] = [];
  const rawGroups: { agents: string[]; rules: RobotsRules }[] = [];
  let current: { agents: string[]; rules: RobotsRules } | null = null;

  const hasRules = (group: { rules: RobotsRules }): boolean =>
    group.rules.allow.length > 0 ||
    group.rules.disallow.length > 0 ||
    group.rules.crawlDelaySeconds !== null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();

    if (!line) continue;

    const separator = line.indexOf(":");

    if (separator < 0) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      // Consecutive User-agent lines share one group; a rule-bearing group
      // ends when the next User-agent line arrives.
      if (!current || hasRules(current)) {
        current = {
          agents: [],
          rules: { allow: [], disallow: [], crawlDelaySeconds: null },
        };
        rawGroups.push(current);
      }

      current.agents.push(value.toLowerCase());
      continue;
    }

    if (field === "sitemap" && value) {
      sitemaps.push(value);

      continue;
    }

    if (!current) continue;

    const rules = current.rules;

    if (field === "disallow") rules.disallow.push(value);
    else if (field === "allow") rules.allow.push(value);
    else if (field === "crawl-delay") {
      const seconds = Number.parseFloat(value);

      if (Number.isFinite(seconds) && seconds >= 0) {
        rules.crawlDelaySeconds = seconds;
      }
    }
  }

  // Merge every raw group into per-agent rule sets (concatenation is safe:
  // matching is longest-prefix, so duplicate prefixes are harmless).
  for (const group of rawGroups) {
    for (const agent of group.agents) {
      const existing = groups.get(agent) ?? {
        allow: [],
        disallow: [],
        crawlDelaySeconds: null,
      };

      existing.disallow.push(...group.rules.disallow);
      existing.allow.push(...group.rules.allow);
      existing.crawlDelaySeconds =
        existing.crawlDelaySeconds ?? group.rules.crawlDelaySeconds;
      groups.set(agent, existing);
    }
  }

  return { groups, sitemaps };
}

/** Merge the UA-specific group with the `*` group (specific wins on conflict). */
export function rulesForAgent(parsed: ParsedRobots, agent: string): RobotsRules {
  const specific = parsed.groups.get(agent.toLowerCase()) ?? {
    allow: [],
    disallow: [],
    crawlDelaySeconds: null,
  };

  const wildcard = parsed.groups.get("*") ?? {
    allow: [],
    disallow: [],
    crawlDelaySeconds: null,
  };

  return {
    disallow: [...specific.disallow, ...wildcard.disallow],
    allow: [...specific.allow, ...wildcard.allow],
    crawlDelaySeconds: specific.crawlDelaySeconds ?? wildcard.crawlDelaySeconds,
  };
}

function longestMatchingPrefix(path: string, prefixes: readonly string[]): string | null {
  let best: string | null = null;

  for (const prefix of prefixes) {
    if (prefix && path.startsWith(prefix)) {
      if (best === null || prefix.length > best.length) best = prefix;
    }
  }

  return best;
}

/** Longest-prefix match; Allow wins ties; empty rules allow everything. */
export function isPathAllowed(path: string, rules: RobotsRules): boolean {
  const disallowMatch = longestMatchingPrefix(path, rules.disallow);
  const allowMatch = longestMatchingPrefix(path, rules.allow);

  if (disallowMatch === null) return true;

  if (allowMatch === null) return false;

  return allowMatch.length >= disallowMatch.length;
}

export interface RobotsFetchOutcome {
  status: number;
  text: string;
}

export interface RobotsCacheOptions {
  fetchRobotsText: (origin: string) => Promise<RobotsFetchOutcome | null>;
  clock: () => number;
  ttlMs?: number;
}

export class RobotsCache {
  private readonly cache = new Map<string, RobotsInfo>();

  constructor(private readonly options: RobotsCacheOptions) {}

  async get(origin: string): Promise<RobotsInfo> {
    const now = this.options.clock();
    const cached = this.cache.get(origin);

    if (cached && now - cached.fetchedAt < (this.options.ttlMs ?? 3_600_000)) {
      return cached;
    }

    let info: RobotsInfo;

    try {
      const outcome = await this.options.fetchRobotsText(origin);

      if (outcome === null || outcome.status >= 500) {
        // Unreadable robots: fail closed (architecture §4.17).
        info = {
          origin,
          rules: null,
          failClosed: true,
          sitemaps: [],
          fetchedAt: now,
        };
      } else if (outcome.status >= 400) {
        // No robots.txt: allowed by convention.
        info = {
          origin,
          rules: null,
          failClosed: false,
          sitemaps: [],
          fetchedAt: now,
        };
      } else {
        const parsed = parseRobotsTxt(outcome.text);

        info = {
          origin,
          rules: rulesForAgent(parsed, KNOWLEDGE_USER_AGENT_TOKEN),
          failClosed: false,
          sitemaps: parsed.sitemaps,
          fetchedAt: now,
        };
      }
    } catch {
      info = {
        origin,
        rules: null,
        failClosed: true,
        sitemaps: [],
        fetchedAt: now,
      };
    }

    this.cache.set(origin, info);

    return info;
  }
}
