/**
 * Vendored from the knowledge-crawler engine's retrieval layer (identical
 * semantics; golden tests kept in sync). PR0 promotes this kernel to
 * a shared politeness package and remove the duplication.
 */

/**
 * URL policy: validation, canonicalization, and domain grouping.
 *
 * Every URL entering the system (frontier, registry, redirects) passes through
 * here so that dedup, robots checks, and rate limiting all operate on the same
 * canonical form. Pure module — no network.
 *
 * Canonicalization rules (architecture §6): lowercase host, drop default
 * ports, strip fragments and tracking parameters, sort query parameters,
 * collapse trailing "index.html". Non-http(s) schemes, embedded credentials,
 * and oversized URLs are rejected outright.
 */

const MAX_URL_LENGTH = 2048;

/** Tracking parameters stripped during canonicalization. */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref_src",
]);

/** Parse and validate a knowledge-crawler URL. Returns null when rejected. */
export function parseKnowledgeUrl(
  input: string,
  base?: string,
): URL | null {
  let url: URL;

  try {
    url = base ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  if (url.username || url.password) return null;

  if (!url.hostname || url.hostname.length > 253) return null;

  if (url.href.length > MAX_URL_LENGTH) return null;

  return url;
}

/** Canonical string form used for dedup keys and registry identity. */
export function canonicalizeUrl(url: URL): string {
  const canon = new URL(url.toString());

  canon.hash = "";
  canon.hostname = canon.hostname.toLowerCase();
  canon.username = "";
  canon.password = "";

  if (
    (canon.protocol === "http:" && canon.port === "80") ||
    (canon.protocol === "https:" && canon.port === "443")
  ) {
    canon.port = "";
  }

  const kept = [...canon.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  canon.search = "";

  for (const [key, value] of kept) {
    canon.searchParams.append(key, value);
  }

  if (canon.pathname.endsWith("/index.html")) {
    canon.pathname = canon.pathname.slice(0, -"index.html".length);
  }

  return canon.toString();
}

/** Convenience: parse + canonicalize in one step. Returns null when invalid. */
export function canonicalUrlString(input: string, base?: string): string | null {
  const parsed = parseKnowledgeUrl(input, base);

  return parsed ? canonicalizeUrl(parsed) : null;
}

/**
 * Registrable-domain approximation: equality of the last two DNS labels.
 * Adequate for per-domain rate limiting at S1; full public-suffix handling is
 * a noted S2 refinement.
 */
export function sameSite(a: URL, b: URL): boolean {
  const labels = (host: string) => host.toLowerCase().split(".").slice(-2).join(".");

  return labels(a.hostname) === labels(b.hostname);
}

/** Hostname key for rate limiting and robots scoping. */
export function hostKey(url: URL): string {
  return url.hostname.toLowerCase();
}
