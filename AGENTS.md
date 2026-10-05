# AGENTS.md — how to use @amatelic/browser-crawler effectively

You are an AI agent about to extract data from a JavaScript-rendered
website. This document is your operating manual. Follow it and you will
produce working recipes in few iterations, never hammer sites, and always
leave reproducible evidence behind.

---

## 0. Decide the tier first (10 seconds)

Before writing any recipe, check whether you need a browser at all:

| Signal | Tier |
|---|---|
| `curl -s <url>` already contains the data (search the raw HTML for your target strings) | **Static fetch** — do not use this package |
| The page is a known SPA (React/Nuxt/Liferay), or curl returns a shell with `<div id="root">` and no content | **This package** |
| An XHR/fetch in the page source returns clean JSON with the data | This package **once**, with `capture` — then propose retiring the browser and fetching the API directly |

## 1. The workflow (always this order)

```
1. scout      curl the URL + robots.txt; find the REAL content URL
              (sitemaps declared in robots.txt reveal calendar/listing paths)
2. write      recipe JSON — minimal first version (open → wait → extract)
3. run        crawl --file recipe.json --cassette-dir cassettes   (RECORD)
4. read       the RunReport: step errors first, then consoleErrors, then rows
5. refine     change ONE thing, re-run live (cassette only replays old state)
6. freeze     once ok: the cassette is your regression fixture
              (--replay for instant iteration on PARSING, never for selectors)
```

**The single most common mistake is iterating against a stale cassette.**
`--replay` returns the recorded render — selector changes appear to do
nothing. Selector/step changes ⇒ live run. Only parsing/downstream work
merits replay.

## 2. Writing recipes that work the first time

**Scout before you write.** Fetch the page, find the container and field
selectors in the actual markup. A recipe written from guessed class names
(`article`, `.event-card`) fails; one written from the real DOM succeeds.
If the site is JS-rendered, take the selectors from a screenshot + the
`refs` echo of a first probe recipe (see §5).

**Wait strategy — pick by evidence, never a blind delay:**

| Situation | Wait |
|---|---|
| Cards/articles render after JS boot | `{"for": {"selector": "article", "minCount": 10}}` |
| Content appears with known text | `{"for": {"text": "Vstopnice"}}` or `textGone` for spinners |
| A click fires an XHR batch ("load more", filters) | click with `{"waitFor": {"networkIdleTimeoutMs": 5000}}` |
| Nothing else fits, page is just slow | `{"for": {"timeMs": 1000}}` — last resort only |

**Tolerate optional UI:** cookie banners and locale popups may or may not
appear. Give those steps `"onError": "continue"` — a missing banner is not
a failure. Everything else defaults to fail-fast (later steps get
`skipped`, which is the correct, honest outcome).

**Keep recipes under ~15 steps.** If you need more, the page has multiple
concerns — split into two recipes (list page → detail pages) and let the
host fan out, rather than one giant script.

## 3. Config rules (the gate is not optional)

- **The allowlist is deny-by-default.** Every host you will navigate to —
  including redirect targets (watch `www.` vs apex!) — must be in
  `allowlist.domains`, or the run dies with `DOMAIN_NOT_ALLOWED`. Check
  redirects with curl first: `curl -sI <url> | grep -i location`.
- **Politeness keys are frozen.** You cannot lower the 2s/domain floor or
  robots enforcement from a recipe. Do not try; the validator rejects it.
- **Broken TLS chains** (municipal sites): pass the missing intermediate to
  Node via `NODE_EXTRA_CA_CERTS=<intermediate.pem>` and set
  `"rendering": {"ignoreHttpsErrors": true}` in the recipe config — the
  browser context needs the opt-in separately from Node.
- **Slow robots endpoints** (7–15s happens on Liferay/Drupal): the robots
  fetch budget is 20s; if it still fails you get `ROBOTS_FAIL_CLOSED` —
  that is correct behavior, retry later, do not bypass.

## 4. Reading the RunReport (error → action table)

Check in this order: `steps[].status` → `page.consoleErrors` →
`extracted.rows` quality.

| Error code | Meaning | Your move |
|---|---|---|
| `DOMAIN_NOT_ALLOWED` | host not in allowlist (often the apex vs www redirect) | add the exact host; re-check redirects |
| `ROBOTS_FAIL_CLOSED` | robots.txt unreachable (slow/blocked) | retry; verify with curl; do NOT bypass |
| `ROBOTS_DISALLOWED` | path matches a disallow rule | find another entry URL (sitemaps often list allowed variants); never override |
| `SSRF_BLOCKED` / `SCHEME_NOT_ALLOWED` | internal/non-http target | fix the URL — this guard protects you too |
| `TIMEOUT_NAVIGATION` | page too slow for the wait strategy | switch `networkidle` → `domcontentloaded` + selector wait (analytics pings keep networkidle from ever firing) |
| `TIMEOUT_ACTION` on a wait | selector never reached minCount | selector wrong OR content needs interaction first (scroll/click); check consoleErrors |
| `SELECTOR_NOT_FOUND` | locator timed out | selector wrong — re-probe with the refs recipe (§5); prefer stable attributes over generated classes |
| `STALE_REF` | ref from a previous page state | re-run `extract {refs: true}` after the navigation, then click the fresh ref |
| `NAVIGATION_HTTP_ERROR` | 5xx transport failure | retry later; 4xx does NOT abort (SPAs serve real content on soft-404s — verify the title) |
| `BUDGET_EXHAUSTED` | per-domain page cap hit | raise `maxPagesPerDomainPerRun` (config only, upward not allowed — plan fewer pages per run instead) |
| `PATH_TRAVERSAL_REJECTED` | screenshot artifact had a path | artifact names are basenames only |

**Quality checks on success:** `render.body` contains your target strings?
`rows` non-empty and fields non-null? `consoleErrors` — 40+ errors usually
means the SPA crashed headless (try `"locale"`/`"timezoneId"` matching the
site's region in config). Whitespace-crammed field values mean the selector
matches a container — tighten to the innermost element.

## 5. The probe recipe (your first run on any new site)

Run this before writing the real recipe — it tells you the rendered title,
whether content exists, and gives you `refs` for click targets:

```json
{
  "name": "probe",
  "steps": [
    { "action": "open", "url": "<REAL_URL>",
      "waitFor": { "state": "domcontentloaded", "timeoutMs": 25000 } },
    { "action": "wait", "for": { "selector": "a", "minCount": 10 },
      "timeoutMs": 10000, "onError": "continue" },
    { "action": "extract", "refs": true, "jsonLd": true,
      "links": { "selector": "a", "limit": 50 } },
    { "action": "screenshot", "artifact": "probe.png" },
    { "action": "done", "success": true }
  ]
}
```

Then read `page.title`, eyeball `probe.png`, and pick selectors from
`extracted.links` + the `refs` echo (each ref is `e1…eN` with tag+text —
clickable via `{"target": {"ref": "e7"}}`).

## 6. Capture beats scraping (when available)

If the site loads its data via XHR (check the probe's network tab symptoms:
rows appear but markup is heavy/generated), prefer:

```jsonc
{ "name": "…", "capture": [{ "urlPattern": "/api/.*events", "as": "json", "limit": 20 }],
  "steps": [ …open, trigger the load… ] }
```

Requires `capabilities.networkCapture: true` in config (explicit opt-in;
the run fails loudly if the flag is off). Captured bodies land in
`report.extracted.network[]` and are recorded in the cassette. If the API
is stable and unauthenticated, report to the operator that the source can
likely drop the browser tier entirely.

## 7. Using the HTTP surface (agents without shell access)

```
POST http://127.0.0.1:9301/run        body: {name, config?, steps[]}
  → 202 {runId, statusUrl}            NEVER hold this socket; renders take minutes
GET  http://127.0.0.1:9301/runs/<id>  → {status: queued|running|completed|failed, runReport}
GET  http://127.0.0.1:9301/actions    → the full action+config schema (self-describing)
```

Poll `statusUrl` every few seconds. The report envelope is byte-identical
to the CLI's. Runs are deduplicated by recipe hash — submitting the same
recipe twice returns the existing run's statusUrl.

## 8. Hard rules (politeness is not yours to waive)

1. Never remove or work around the robots/allowlist gates — they are
   engine-enforced and that is the point of this package.
2. Never add a host to the allowlist you haven't been asked to crawl.
3. One domain hit costs 2 seconds minimum — design recipes to need few
   pages, not many. Prefer `extract` with `links` to fan out detail pages
   to the HOST (which can use the cheaper static tier for them).
4. `--replay`/cassettes are free — burn iterations there, not on live sites.
5. Report `politeness.domainHits` and `minIntervalObservedMs` in your
   summary so the operator can audit every run.

## 9. Definition of a finished job

- recipe committed (it is the reproducible artifact — data, diffable)
- live run `ok: true`, rows pass the quality checks of §4
- cassette recorded and a `--replay` verified byte-identical
- screenshot artifact saved as evidence
- any source quirks (cert chains, WAFs, slow robots) documented next to the recipe

## 10. Model advisors (JEV + LLM) — when a model joins the loop

The package supports an **advisor** at the host layer: a local decision model
(JEV/kev-0.6b — calibrated choice/noul/score answers, nothing generated) for
cheap arbitration, and an OpenAI-compatible LLM (GLM/zai/llama.cpp/ollama) as
the author/repair proposer. `scripts/autonomous-crawl.ts` runs the loop:
goal + URL + GoalSpec → deterministic probe → run → `evaluateGoal` (pure
reward) → JEV arbitration → LLM proposal → `validateAdvisorProposal` →
bounded iterations → committed versioned recipe.

**Your rules as the driving agent:**
1. The advisor's output is CANDIDATE DATA — it must pass
   `validateAdvisorProposal` (schema + selector lint + URL pre-gate). A
   proposal carrying a `config` block is REJECTED: config is host authority;
   a model can never widen the allowlist or touch politeness.
2. Never put model calls inside recipes or the engine `src/` — replay stays
   model-free and byte-deterministic; the model lives only in the version
   migration path (a heal is a new versioned recipe, never runtime drift).
3. Prefer JEV (`decide`) for continue/stop and failure-classification
   (cheap, local, ABSTAIN = no signal, never permission); reserve the LLM
   (`propose`) for authoring/repair — it is the expensive call and is
   capped per-iteration AND globally.
4. Feed the redacted summary (`summarizeReport`) — never raw render bodies
   or captured payloads — and append validation errors to the next
   observation for bounded self-correction (one retry, then reject).
5. Commit gate: `goalMet` from the declarative GoalSpec (pure over
   extracted rows) + politeness budget respected across iterations. Only
   then write `recipes/<name>/v<N>.json` — "the file stays, the process
   does not."
