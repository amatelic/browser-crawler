# @amatelic/browser-crawler

**Crawl JavaScript-rendered websites with declarative JSON recipes — politely, reproducibly, and without writing browser code.**

Modern event calendars, city portals, and listing sites render their content client-side. A static fetcher sees an empty shell. This package drives a real headless browser through a **recipe** — a small JSON file that says *open this page, dismiss the banner, wait for the cards, extract the fields* — while enforcing the politeness rules serious crawlers need: robots.txt (fail-closed), per-domain rate spacing, SSRF protection, and a deny-by-default domain allowlist.

Built for the workflow where **agents do the driving**: an LLM agent, CI job, or your own script writes a recipe, runs one command, and gets one structured JSON report back.

```jsonc
// praha-calendar.json — the whole program
{
  "name": "praha-calendar",
  "steps": [
    { "action": "open", "url": "https://praha.eu/kalendar-akci",
      "waitFor": { "state": "domcontentloaded", "timeoutMs": 25000 } },
    { "action": "wait", "for": { "selector": "article", "minCount": 10 }, "timeoutMs": 8000 },
    { "action": "extract",
      "itemSelector": "article",
      "fields": [
        { "name": "title", "selector": "h3",   "as": "text" },
        { "name": "url",   "selector": "a",    "as": "attr", "attr": "href" },
        { "name": "date",  "selector": "time", "as": "attr", "attr": "datetime" }
      ],
      "jsonLd": true }
  ]
}
```

```bash
npx @amatelic/browser-crawler crawl --file praha-calendar.json
# → RunReport JSON on stdout: rows, jsonLd, rendered HTML, politeness ledger, artifacts
```

## Why this exists

| Problem | What this package does |
|---|---|
| SPA content invisible to `fetch` | Real chromium renders the page; extraction reads the **post-JS DOM** (including JSON-LD that only appears after render) |
| Browser scripts rot fast | Recipes are **data** — diffable in git, writable by agents, replayable from cassettes — not Selenium scripts |
| "Wait 3 seconds and pray" | Deterministic waits: selector-count, text, network-quiescence (`waitFor.networkIdleTimeoutMs`) |
| Crawlers that hammer sites | Politeness enforced in the engine, not by discipline: robots fail-closed, 2s/domain floor, page budgets, per-URL-transition re-gating |
| Flaky reruns | Render-level **cassettes**: replay a recorded run byte-identically in milliseconds, no browser launched |
| Agents need to drive browsers safely | A localhost HTTP surface (`POST /run` → poll → report) with a machine-readable action schema at `GET /actions` |

## Install

```bash
pnpm add @amatelic/browser-crawler        # playwright 1.62 pinned — shared chromium cache
npx playwright install chromium           # once, if not already present
```

## The three surfaces (one report envelope)

**CLI** — humans and CI:

```bash
pnpm crawl -- --file examples/praha-calendar.json [--config my.config.json] \
  [--cassette-dir cassettes] [--replay | --strict-replay]
# exit codes: 0 ok · 2 validation · 3 politeness deny · 4 step failure
```

**Importable API** — programmatic use and host-side hooks:

```ts
import {
  parseInstructionInput, validateInstructionSet, loadConfig, runInstructions,
  type BrowserCrawlerHooks,
} from "@amatelic/browser-crawler";
import { chromium } from "playwright";

const parsed = validateInstructionSet(parseInstructionInput(recipeJson));
const config = loadConfig("browser-crawler.config.json", parsed.instructionSet.config);

const hooks: BrowserCrawlerHooks = {
  onStepResult: (step) => { if (step.error?.code === "STALE_REF") retryQueue.enqueue(parsed.runId); },
  onNavigation: (url, ok, code) => metrics.politeness(url, ok, code),
};

const report = await runInstructions(parsed, config, {
  clock: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchRobotsText: async (origin) => {
    const res = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(20_000) });
    return { status: res.status, text: await res.text() };
  },
  browserFactory: async (cfg) => chromium.launch({ headless: cfg.headless }),
  hooks,                                            // ← interception lives here
  cassette: { dir: "cassettes", mode: "record" },   // replay never launches chromium
});

report.extracted.rows;      // harvested fields
report.extracted.jsonLd;    // from the rendered DOM
report.render.body;         // fully rendered post-JS HTML
report.render.contentHash;  // change-detection key
```

**Agent HTTP** — loopback-only service agents POST to:

```bash
pnpm server    # → http://127.0.0.1:9301

curl -X POST http://127.0.0.1:9301/run -H 'content-type: application/json' \
  -d '{"name":"demo","steps":[{"action":"open","url":"https://praha.eu/kalendar-akci"}]}'
# → 202 {"runId":"b3f…","statusUrl":"/runs/b3f…"}   (renders take minutes — never held)

curl http://127.0.0.1:9301/runs/b3f…   # → {status, runReport}
curl http://127.0.0.1:9301/actions     # → machine-readable action schema
```

## Core concepts

**Recipe (data only).** 13 actions: `open · click · fill · select · press_key · hover · scroll · wait · extract · screenshot · back · close · done`. Steps run in order, fail fast (later steps marked `skipped`), and `onError: "continue"` marks a step as tolerated (a missing cookie banner doesn't fail the run). Targeting is `{"selector": css}` · `{"ref": "e12"}` (echoed by `extract {refs: true}`; stale after navigation → explicit `STALE_REF`) · `{"selector": css, "text": "Next"}`. JSONL variant supported (one step per line, `//` comments).

**Config (data, with frozen keys).** Viewport/UA/locale/timezone, three-tier timeouts (navigation 60s / action 5s / settle 500ms), resource blocking (images/media/fonts + tracker origins), domain **allowlist (deny-by-default)**. The `politeness` block is engine-frozen — recipe overrides are validation errors; only `maxPagesPerDomainPerRun` may decrease. One honest UA token, no rotation.

**Capabilities (the callback layer).** Recipes never contain code. Host-side interception — browser factory, clock, robots transport, and lifecycle hooks (`onStepResult`, `onNavigation`; hook errors never kill a run) — is injected via the capabilities object.

**Interception primitives (declarative).**
- `waitFor: {networkIdleTimeoutMs}` on `click`/`fill` — settle only when the XHR batch finished loading (no delay guessing)
- `afterMs` per step / `interStepDelayMs` config — static pacing
- `capture: [{urlPattern, as, limit}]` — record matching XHR/fetch response bodies into `report.extracted.network[]` (requires the `networkCapture` capability flag; cassette-replayable). Often the real data behind the DOM — and the fastest path to retiring the browser for a source.

## Politeness guarantees (engine-enforced, every run)

1. robots.txt **fail-closed** (unreachable ⇒ no crawl; 404 ⇒ allowed) with the same literal-prefix matcher semantics as a static fetcher
2. Per-domain spacing (2s floor; robots `Crawl-delay` raises it) and per-domain page budgets
3. SSRF: DNS pre-resolution refuses private/link-local targets — before the browser navigates
4. Domain allowlist, deny-by-default; non-http(s) schemes rejected
5. **Every URL transition re-gated** — clicks that navigate, JS redirects, meta refreshes — fail-closed on denial
6. Popups (`target=_blank`, `window.open`) closed on sight
7. Resource blocking keeps crawl traffic light (images/fonts/trackers aborted)

## Cassettes

Key = `sha256(canonical recipe) + configHash`. Record once; replay strictly — the recorded render and captured responses return byte-identically, **chromium is never launched** (verified by tests with a throwing browser factory). `--strict-replay` errors on misses instead of going live. Screenshots are report artifacts, not cassette payloads.

## RunReport (identical across all surfaces)

`ok · runId · render{finalUrl, httpStatus, body, contentHash, redirectChain, decisions[]} · page{title, consoleErrors, requests{total,blocked}} · steps[{seq,label,action,status,ms,error{code,message},skippedReason}] · extracted{rows,jsonLd,links,network} · artifacts[] · politeness{domainHits,minIntervalObservedMs} · cassettePath`

Error codes: `SELECTOR_NOT_FOUND · STALE_REF · TIMEOUT_NAVIGATION/ACTION · ROBOTS_DISALLOWED/FAIL_CLOSED · SSRF_BLOCKED · DOMAIN_NOT_ALLOWED · BUDGET_EXHAUSTED · REDIRECT_ORIGIN_DENIED · PATH_TRAVERSAL_REJECTED · NAVIGATION_HTTP_ERROR · CAPABILITY_DISABLED · …`

## For AI agents

If YOU are an agent about to use this package: read **[AGENTS.md](./AGENTS.md)** first — it is the operating manual (tier decision, the probe recipe, wait-strategy table, error→recovery table, hard politeness rules, definition of a finished job).

## Proven in the wild

Shipped against praha.eu — a WAF-fronted Liferay SPA with an incomplete TLS chain that static crawlers score zero on: 310KB rendered DOM, 21 rows extracted, full politeness ledger, cassette replay in **2ms vs 35s live**. The debugging history (and every design decision, adversarially verified) is in [DESIGN.md](./DESIGN.md).

## Development

```bash
pnpm install
pnpm build | pnpm test | pnpm typecheck | pnpm check:boundaries
# 23 tests incl. real-chromium fixture integration — no external network needed
```

MIT — see [LICENSE](./LICENSE).
