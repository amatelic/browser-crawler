# ExecPlan: @doha/browser-crawler (agent-first Playwright render tier)

**Status:** v0.1 SHIPPED 2026-10-04 (design workflow-verified; 5 refuted claims + 2 politeness holes corrected pre-build) · **Next:** PR0 kernel promotion, knowledge-crawler RoutingGateway adoption (PR3), live praha.eu smoke

## What shipped

- **Protocol contracts in `@doha/shared/src/browser-crawler/`**: 13-action TypeBox discriminated union (`open click fill select press_key hover scroll wait extract screenshot back close done`), dual selector/ref targeting, error-code union, config schema + defaults, `fetched_browser` render state (verifier correction: `rendered_browser` failed the `startsWith("fetched")` relaxation).
- **Engine package `packages/browser-crawler`** (backend-independent, boundary-checked: also bans knowledge-crawler/pg/pipeline imports):
  - Config loader with **frozen politeness keys** (only `maxPagesPerDomainPerRun` may decrease)
  - Single-boundary instruction validation (JSON / bare array / JSONL-with-comments); deterministic `runId = sha256(canonical instructions)`, cassette key = `runId + configHash` (verifier correction)
  - **PolitenessGate**: scheme → domain allowlist (deny-by-default) → DNS pre-resolution SSRF → robots fail-closed → per-domain spacing → per-domain page budget — and the gate re-runs on EVERY URL transition (click/submit/JS/meta redirects; verifier hole #1) with fail-closed denial
  - Popup killer: `context.on("page")` closes opener-bearing pages (verifier hole #2 — tested with target=_blank)
  - Actions per design; `wait` merges selector/time/text modes (browser-side `waitForFunction` for real-time rendering); `extract` fans rows + rendered-DOM JSON-LD + scoped links + page-level refs echo; `scroll` = notches×800px (verifier correction: Playwright takes pixel deltas); screenshots return paths, artifact names are basenames (traversal rejected at schema AND writer)
  - Render-level cassettes (format v2, `mode: browser-render`): strict replay never launches chromium (tested via throwing browserFactory); trace/HAR deliberately NOT replay inputs
  - Playwright pinned **1.62.0** = lockfile's cached chromium (verifier correction: ^1.57 would download a new revision)
- **Agent surfaces**: CLI `pnpm --filter @doha/browser-crawler crawl -- --file examples/praha-calendar.json` (script named `crawl` — verifier correction: `run -- --file` fails with ERR_PNPM_NO_SCRIPT); importable `runInstructions`/`loadConfig`/schemas; localhost HTTP **:9301** (`POST /run` → 202 `{runId,statusUrl}` + dedupe, `GET /runs/:id`, `GET /actions`, `GET /health`)
- **Tests: 18/18** — schema/bounds/traversal units, config frozen-key guard, robots fail-closed matrix, allowlist deny, page-budget exhaustion, real-chromium fixture-SPA integration (happy path rows/jsonLd/links/refs/screenshot, STALE_REF, fail-fast skip-rest, popup close, banner onError:continue), cassette record→replay→strict-miss; server surface 3/3. Boundaries ok. Typecheck 0.

## v0.2 shipped (same day): declarative interception primitives

- `click`/`fill` `waitFor: {networkIdleTimeoutMs}` — network-quiescence settle for XHR-batching SPAs (playwright networkidle)
- `afterMs` per step + config `rendering.interStepDelayMs` — static pacing (per-step wins when larger)
- `capture: [{urlPattern, as, limit}]` at the instruction-set level — matching XHR/fetch response bodies recorded into `report.extracted.network[]`, gated behind `capabilities.networkCapture` (explicit failure when rules present but flag off), cassette v2 records/replays captures
- Fixture web gained a `/api/events` XHR on load-more; 3 new tests (quiescence+capture, capability gate, cassette replay of captures) — **21/21**

## Known residual (this v0.1)

- 12 anti-slop lint errors remain in the package (down from 95 during build) — mostly recursive-union boundary ergonomics in validate/loader; not yet in any CI gate. Polish pass pending.
- Politeness kernel is VENDORED from knowledge-crawler (identical semantics, headers marked) — **PR0 promotes robots/rate-limiter/ssrf/url-policy + FetchResult to @doha/shared** and removes duplication.
- PR3 adoption (knowledge-crawler `RoutingGateway` static-first/browser-fallback) needs: minimal `FetchGateway` interface (generation-zero currently types the concrete class), success-check relaxation to `startsWith("fetched")` at TWO sites (generation-zero + extraction-pass).
- maxRedirects enforcement counts main-frame document requests (iframe inflation fixed per verifier); XHR egress to non-allowlisted hosts still possible (service-worker blocking only) — documented tradeoff.
- Live SPA smoke (praha.eu, visitljubljana) is manual: `pnpm --filter @doha/browser-crawler crawl -- --file examples/praha-calendar.json --cassette-dir cassettes` after adding the host to `browser-crawler.config.json` allowlist.
