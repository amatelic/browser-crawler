# @doha/browser-crawler

Agent-first Playwright render tier: **declarative JSON/JSONL "recipes"** that
render JS-SPA sources under the same non-negotiable politeness regime as the
static fetcher (robots fail-closed, 2s/domain spacing, SSRF, deny-by-default
domain allowlist — re-checked on *every* URL transition, popups killed).

Three surfaces, one byte-identical RunReport envelope: **CLI**, **importable
API**, **localhost HTTP (:9301)**.

---

## 1. The recipe (JSON or JSONL)

```jsonc
{
  "name": "praha-calendar",
  // v0.2 declarative interception: capture XHR responses (needs the
  // capabilities.networkCapture flag in config)
  "capture": [{ "urlPattern": "/api/.*events", "as": "json", "limit": 20 }],
  "steps": [
    { "label": "open calendar", "action": "open",
      "url": "https://www.praha.eu/kalendar",
      "waitFor": { "state": "networkidle", "timeoutMs": 20000 } },

    // banner may or may not exist → continue on error
    { "label": "banner", "action": "click",
      "target": { "selector": "#cookie-accept" }, "onError": "continue" },

    // wait until 10 event cards rendered (browser-side, real time)
    { "label": "cards render", "action": "wait",
      "for": { "selector": "article.event", "minCount": 10 }, "timeoutMs": 8000 },

    // v0.2: click "load more" and settle only once the XHR batch finished
    { "label": "load more", "action": "click",
      "target": { "selector": "#load-more" },
      "waitFor": { "networkIdleTimeoutMs": 5000 },
      "afterMs": 300 },

    { "label": "harvest", "action": "extract",
      "itemSelector": "article.event",
      "fields": [
        { "name": "title", "selector": "h3", "as": "text" },
        { "name": "url",   "selector": "a",  "as": "attr", "attr": "href" },
        { "name": "date",  "selector": "time", "as": "attr", "attr": "datetime" }
      ],
      "jsonLd": true,                       // JSON-LD from the RENDERED dom
      "links": { "selector": "a[href*='/kalendar/']", "limit": 200 },
      "refs": true },                       // e1..eN for click-by-ref

    { "label": "evidence", "action": "screenshot", "artifact": "praha-1.png" },
    { "action": "done", "success": true, "note": "28 events" }
  ]
}
```

JSONL variant (one step per line, `//` comments allowed):
`examples/visitljubljana-events.jsonl`.

**Actions (13):** `open · click · fill · select · press_key · hover · scroll ·
wait · extract · screenshot · back · close · done`

**Targeting:** `{"selector": css}` · `{"ref": "e12"}` (from the last
`extract {refs:true}` echo — stale after navigation → `STALE_REF`) ·
`{"selector": css, "text": "Next"}`.

## 2. Config file (`browser-crawler.config.json`)

```jsonc
{
  "viewport": { "width": 1366, "height": 768 },
  "userAgent": "Mozilla/5.0 (compatible; nomadia-browser-renderer/0.1)",
  "locale": "cs-CZ",                 // SPAs render per locale/TZ
  "timezoneId": "Europe/Prague",
  "timeouts": { "navigationMs": 60000, "actionMs": 5000, "settleMs": 500 },
  "rendering": { "interStepDelayMs": 0 },   // v0.2 static pacing
  "allowlist": { "domains": ["www.praha.eu"] },  // deny-by-default
  "blocking": { "resourceTypes": ["image", "media", "font"],
                "blockOrigins": ["googletagmanager.com"],
                "blockServiceWorkers": true },
  "capabilities": { "javascriptEval": false, "networkCapture": false }
}
```

`politeness` (robots fail-closed · 2s/domain · page budget) is
**engine-frozen** — recipe overrides are validation errors; only
`maxPagesPerDomainPerRun` may decrease.

## 3. CLI

```bash
pnpm --filter @doha/browser-crawler crawl -- --file examples/praha-calendar.json \
  [--config my.config.json] [--cassette-dir cassettes] [--replay | --strict-replay]
# RunReport JSON → stdout (pipe into jq), human summary → stderr
# exit codes: 0 ok · 2 validation · 3 politeness deny · 4 step failure
```

## 4. Importable API (capabilities = the callback layer)

```ts
import {
  runInstructions, loadConfig, parseInstructionInput,
  type BrowserCrawlerHooks,
} from "@doha/browser-crawler";
import { chromium } from "playwright";

const hooks: BrowserCrawlerHooks = {
  // Host-side lifecycle interception — observability, retries, branching.
  // Hook errors are swallowed (logged): host bugs never kill a run.
  onStepResult: async (step) => {
    if (step.status === "error" && step.error?.code === "STALE_REF") {
      // e.g. enqueue a repair recipe from YOUR side
    }
  },
  onNavigation: (url, ok, code) => { /* every politeness verdict */ },
};

const report = await runInstructions(parsed, config, {
  clock: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchRobotsText: async (origin) => { /* your SSRF-safe fetcher */ },
  browserFactory: async (cfg) => chromium.launch({ headless: cfg.headless }),
  hooks,                                     // ← callbacks live HERE
  cassette: { dir: "cassettes", mode: "record" },
});
```

**Where callbacks live — the rule:**

| Layer | Shape | Extend it when you want… |
|---|---|---|
| Recipe JSON | data only | new *actions*/flags (protocol growth) |
| Config JSON | data only (frozen politeness) | new knobs of WHAT the browser is |
| **Capabilities object** | **functions (callbacks)** | to intercept behavior: browser factory, clock, robots transport, lifecycle hooks |

Configs are files — JSON cannot hold functions, and data must stay mergeable/
diffable. Anything behavioral belongs in capabilities, which the embedding
host constructs in code.

```ts
import {
  runInstructions, loadConfig, parseInstructionInput,
} from "@doha/browser-crawler";
import { chromium } from "playwright";

const parsed = parseInstructionInput(recipeJson);       // JSON | JSONL | Step[]
const config = loadConfig("browser-crawler.config.json", parsed.instructionSet.config);

const report = await runInstructions(parsed, config, {
  clock: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchRobotsText: async (origin) => {
    const res = await fetch(`${origin}/robots.txt`);
    return { status: res.status, text: await res.text() };
  },
  browserFactory: async (cfg) => chromium.launch({ headless: cfg.headless }),
  cassette: { dir: "cassettes", mode: "record" },       // replay: no chromium
});

report.extracted.rows;      // harvested fields
report.extracted.jsonLd;    // from the rendered DOM
report.extracted.network;   // v0.2 captured XHR bodies (json parsed)
report.render.body;         // fully rendered post-JS HTML
report.render.contentHash;  // change-detection key (spine-compatible)
```

## 5. Agent HTTP surface (:9301, loopback-only)

```bash
pnpm --filter @doha/browser-crawler server   # → http://127.0.0.1:9301

curl -X POST http://127.0.0.1:9301/run -H 'content-type: application/json' \
  -d '{"name":"praha-calendar","steps":[{"action":"open","url":"https://www.praha.eu/kalendar"}]}'
# → 202 {"runId":"b3f…","statusUrl":"/runs/b3f…"}   (renders take minutes)

curl http://127.0.0.1:9301/runs/b3f…   # → {status, runReport} — same envelope
curl http://127.0.0.1:9301/actions     # → machine-readable action schema
```

## 6. v0.2 interception primitives (declarative — recipes stay data)

| Primitive | Where | What it solves |
|---|---|---|
| `waitFor: { networkIdleTimeoutMs }` | `click` / `fill` | "wait for the patch to load": settles only after network quiescence — no blind delay guessing for XHR-batching SPAs |
| `afterMs` / config `rendering.interStepDelayMs` | any step / global | static pacing for fragile SPAs (per-step wins when larger) |
| `capture: [{ urlPattern, as, limit }]` | instruction set | records matching XHR/fetch **response bodies** into `report.extracted.network[]` — often the real data behind the DOM (and the fastest path to retiring the browser tier for a source); requires `capabilities.networkCapture` or the run fails explicitly; cassette-replayable |

Code hooks live at the **host** layer (`capabilities` injection —
`browserFactory` today, observability callbacks next), never inside recipe
files: recipes stay diffable, agent-writable, and replay-deterministic.

## 7. RunReport shape (identical across all three surfaces)

`ok · runId · render{requestedUrl, finalUrl, state:"fetched_browser", httpStatus, body, contentHash, redirectChain, decisions[]} · page{title, consoleErrors, requests{total,blocked}} · steps[{seq,label,action,status:ok|error|skipped,ms,data,error{code,message},skippedReason}] · extracted{rows,jsonLd,links,network} · artifacts[] · politeness{domainHits,minIntervalObservedMs} · cassettePath`

Error codes: `SELECTOR_NOT_FOUND · STALE_REF · TIMEOUT_NAVIGATION/ACTION ·
ROBOTS_DISALLOWED/FAIL_CLOSED · SSRF_BLOCKED · DOMAIN_NOT_ALLOWED ·
BUDGET_EXHAUSTED · REDIRECT_ORIGIN_DENIED · PATH_TRAVERSAL_REJECTED · …`

## 8. Cassettes

Key = `sha256(canonical instructions) + configHash` → `{version:2,
mode:"browser-render", entries:[{key, renderedHtmlBase64, networkCaptures,
decisions…}]}`. Replay mode never launches chromium (proven by tests with a
throwing `browserFactory`); `--strict-replay` errors on cassette misses
instead of going live. Screenshots are artifacts (paths in the report), not
cassette payloads.

## Commands

```bash
pnpm --filter @doha/browser-crawler build | test | typecheck | check:boundaries | crawl | server
```

Design provenance + verification: `specs/execplans/browser-crawler.md`.
