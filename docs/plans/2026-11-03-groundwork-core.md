# Groundwork Core (resolution, sections, dossier, report, watches) Implementation Plan

**Goal:** Build Groundwork's dossier engine on one Cloudflare Worker: address resolution against the Philadelphia atlas, four free Fetch sections with screenshots, four serial Agent sections in a Workflow, the dossier JSON and the server-rendered report, Monitor watches with events, and the read API, ready to build the three demo dossiers and start the live clock.

**Architecture:** Hono app on Workers with D1, R2 and a Cloudflare Workflow. `POST /api/dossiers` resolves the address with TinyFetch, builds the four free sections in parallel (with the Loading-placeholder retry), stores a TinyBrowser screenshot per section, and starts a Workflow instance that runs the Agent sections one at a time (the account-wide rule: one Agent run in flight per build). The report at `/d/:id` is server-rendered HTML in the Drafting Table world. Watches create Page monitors on the atlas licences and assessment pages; webhooks that pass the incomplete-page guard become structured events.

**Tech Stack:** TypeScript (ESM, strict), Hono, Cloudflare Workers + D1 + R2 + Workflows + Cron Triggers, Vitest with `@cloudflare/vitest-pool-workers`, Wrangler 4. Same conventions as `../fineprint` and `../standing`; copy their tested TinyFish client, Monitor client, TinyBrowser screenshot, spend ledger and admin auth modules where they exist.

**Spec:** `docs/specs/2026-11-03-groundwork-design.md`. Demo addresses: `docs/demo-addresses.md`. Design: `DESIGN.md`, `design/tokens.css`, `design/PRINCIPLES.md` (applies to the report in Task 8 and the viewer later). Spike scripts and real responses: `../spikes/spike-philly*.mjs`, `../spikes/out/philly*.json`.

## Global Constraints

- Node `>=24`, ESM, exact version pins, `npm run check` = `tsc --noEmit && vitest run && wrangler deploy --dry-run`, green after every task.
- Secrets only via Worker secrets / `.dev.vars`: `TINYFISH_API_KEY`, `ADMIN_TOKEN`, `WEBHOOK_SECRET`.
- Constants in `src/core/limits.ts`: `AGENT_MAX_STEPS = 14`, `AGENT_MAX_DURATION_SECONDS = 170`, `MAX_MONITORS = 10`, `CURATED_ADDRESSES = 3`, `PUBLIC_WATCH_SLOTS = 4`, `PUBLIC_WATCH_TTL_DAYS = 7`, `PUBLIC_DOSSIERS_PER_IP_PER_DAY = 3`, `PUBLIC_UPGRADES_PER_IP_PER_DAY = 1`, `CACHE_HOURS = 24`, `PUBLIC_DOSSIER_TTL_DAYS = 7`, `FLOOD_RETRY_DAYS = 7`, `FETCH_RETRY_ON_LOADING = 3`, `FETCH_RETRY_DELAY_MS = 10000`, `DEEP_ROWS_MAX = 100`, `PUBLIC_AGENT_PAUSE_USD = 6`, `SPEND_PAUSE_USD = 8`.
- Prices in `src/core/spend.ts`: `agent_step 0.016`, `monitor_check 0.005`, `screenshot 0.002`, `fetch 0`, `search 0`.
- Section status enum: `ok | empty | unavailable | pending | error`. Dossier status: `partial | complete | failed`. Resolution: `exact | fuzzy | parent`. Outcome: `resolved | ambiguous | no_match`. Depth: `recent | extended | full`. Event kinds: `new_permit | new_violation | violation_closed | new_inspection | new_appeal | certification_expired | assessment_change | sale | other`.
- Every TinyFish call goes through `src/tinyfish/client.ts`. Agent 429 → wait 60 s, retry 3 times. **At most one Agent run in flight for this build**, enforced by the Workflow's serial steps plus an `agent_inflight` row in D1 that the deep run also respects.
- Atlas reads that contain a `Loading` placeholder or a section header with a count but no rows are incomplete: retry up to 3 times, 10 s apart; a Monitor payload in that state is ignored.
- No cron that reads a city site. No stealth browser profile anywhere in this build. The FEMA probe uses the standard profile and reports `unavailable` on no results.
- Live TinyFish calls during the build: free Fetch to record fixtures (logged in `docs/build-log.md`); Agent and Browser calls only in the opt-in integration tests, each under $0.25, and only once I have checked what they cost.
- Deploy, remote D1/R2/Workflow creation and the demo dossiers only when I decide to. Push after each task is allowed (origin exists).

## What to check hardest

1. "1234 market st." (trailing period) and "1234 Market St Philadelphia PA 19107" must resolve to the same OPA account as "1234 Market St"; the atlas rejects both raw forms. Test in Task 2.
2. A `/li` read with "Loading permits…" must never be stored as a section and never create an event; the third retry failing marks the section `error` with reason `incomplete_after_retries`. Tests in Tasks 3 and 9.
3. A Monitor `changed` payload whose only difference is row order or a timestamp must produce no event. Test in Task 9.
4. A public dossier must be free-tier with Agent sections `pending: false` and a visible upgrade price; after `PUBLIC_AGENT_PAUSE_USD` the upgrade returns 503 with the pause reason and curated dossiers still run. Tests in Tasks 6 and 7.
5. A condominium parent (1500 Market St fixture) must produce a `resolved` dossier with `resolution: "parent"` and a units count, not `ambiguous`. Test in Task 2.

---

## File Structure

```
groundwork/
  package.json  tsconfig.json  wrangler.jsonc  vitest.config.ts  tests/setup.ts  .dev.vars.example  LICENSE  README.md
  DESIGN.md  design/tokens.css  design/PRINCIPLES.md     (present)
  migrations/0001_init.sql
  src/index.ts  src/env.ts  src/core/limits.ts  src/core/spend.ts  src/auth.ts
  src/address/normalize.ts   normalizeAddress, addressVariants, compareResolved
  src/address/resolve.ts     resolveAddress (atlas /property via Fetch)
  src/sections/types.ts      SectionAdapter, SectionResult, Row types
  src/sections/property.ts  li.ts  zoning.ts  deeds.ts            (Fetch sections, parsers, diffs)
  src/sections/assessmentHistory.ts  tax.ts  schools.ts  flood.ts  liDeep.ts   (Agent sections: goals, schemas, parsers)
  src/sections/index.ts      ordered registry of sections
  src/tinyfish/client.ts fetch.ts agent.ts browser.ts monitor.ts   (copied from siblings, plus fetchAtlas with the Loading retry)
  src/db/types.ts dossiers.ts sections.ts parcels.ts watches.ts events.ts publicUse.ts inflight.ts
  src/dossier/build.ts       createDossier, buildFreeSections, startAgentSections, applyTier
  src/dossier/workflow.ts    DossierAgentWorkflow (serial Agent steps)
  src/dossier/document.ts    toDossierDocument (spec 4.2)
  src/report/render.ts       renderReport (server-rendered HTML, Drafting Table)
  src/report/templates/      layout, sheet, title block, gap sheet, progress sheet (string templates)
  src/handlers/dossiers.ts  watches.ts  webhooks.ts  read.ts  objects.ts  admin.ts
  src/cron.ts
  scripts/build-demos.mjs    builds the three demo dossiers deep and watches them
  tests/fixtures/atlas/      property-1234-market.md  li-1234-market.md  li-loading.md  zoning-1234-market.md  deeds-1234-market.md  property-1500-market.md  property-empty.json
  tests/fixtures/agent/      li-deep.json  (from ../spikes/out/philly-li.json)  fema-noresults.json
  tests/*.test.ts  tests/integration/*.live.test.ts
  docs/runbook.md  docs/build-log.md  .github/workflows/check.yml
```

---

### Task 1: Scaffold, schema, limits, spend, auth, smoke test

**Files:** as in the sibling plans' Task 1, plus a Workflow binding.

**Interfaces:**
- `Env = { DB; STORE; DOSSIER_WORKFLOW: Workflow; TINYFISH_API_KEY; ADMIN_TOKEN; WEBHOOK_SECRET; PUBLIC_BASE_URL }`.
- `wrangler.jsonc`: `name "groundwork"`, D1 `DB` (`groundwork`), R2 `STORE` (`groundwork`), `workflows: [{ name: "groundwork-agent-sections", binding: "DOSSIER_WORKFLOW", class_name: "DossierAgentWorkflow" }]`, `triggers.crons: ["30 * * * *"]`, `vars.PUBLIC_BASE_URL`, `observability.enabled`.
- Schema exactly as spec section 5 plus `agent_inflight (id INTEGER PK CHECK(id = 1), run_id TEXT, started_at TEXT)` and `sections.rows_returned`, `sections.depth`, `dossiers.workflow_id`.
- `recordSpend`, `PRICES`, `totalSpend`, `isAdmin`, `adminOnly`: copy from `../standing/src` or `../fineprint/src`.

- [ ] **Step 1: Write the failing smoke test** (`GET /api/stats` → `{dossiers: 0, sections: {}, watches: 0, events: 0, spend_usd: 0, public_paused: false}`; `POST /api/admin/ping` without token → 401)
- [ ] **Step 2: Run to verify it fails**
- [ ] **Step 3: Create the scaffold; `DossierAgentWorkflow` is an empty class extending `WorkflowEntrypoint` for now**
- [ ] **Step 4: Run to verify it passes; `npm run check`**
- [ ] **Step 5: Commit** `git commit -m "feat: scaffold Worker, D1 schema, Workflow binding, spend ledger, admin auth"`

---

### Task 2: Address normalization and resolution

**Files:**
- Create: `src/address/normalize.ts`, `src/address/resolve.ts`, `src/tinyfish/client.ts`, `src/tinyfish/fetch.ts` (copied, plus `fetchAtlas`)
- Test: `tests/address.test.ts`; fixtures `tests/fixtures/atlas/property-1234-market.md`, `property-1500-market.md` (from `../spikes/out/philly-pages.json`, the `1500 Market St/property` entry), `property-empty.json` (the `empty_content` error shape)

**Interfaces:**
- `normalizeAddress(input: string): { street: string; unit: string | null; display: string }` implementing spec 4.1 step 1 (strip city/state/ZIP, trailing punctuation, suffix map, unit extraction, uppercase display).
- `addressVariants(input: string): string[]` → `[raw, normalized]` deduped.
- `fetchAtlas(env, address: string, tab: "property" | "li" | "zoning" | "deeds"): Promise<{ ok: true; text: string; url: string } | { ok: false; error: string; url: string }>` with the Loading-placeholder retry (`isIncomplete(text)` exported: true when `/Loading/i` matches or a `## Name (N)` header with N > 0 has no table rows beneath).
- `resolveAddress(env, input: { address?: string; opa_account?: string; unit?: string }): Promise<{ outcome: "resolved"; resolution: "exact" | "fuzzy" | "parent"; address_resolved: string; opa_account: string; units: { count: number; list: null } | null; property_text: string; variants_tried: string[] } | { outcome: "no_match"; variants_tried: string[]; manual_url: string } | { outcome: "ambiguous"; candidates: { address: string; url: string }[] }>`. Parent detection: `/There are (\d+) condominium units/` or `/There are (\d+) active parcels/` with N > 1. Fuzzy: `compareResolved(input, h1)` returns `"fuzzy"` when the street name's Levenshtein ratio is below 0.9 after suffix normalization.

- [ ] **Step 1: Write the failing tests**

```ts
it("normalizes trailing period, city, state and ZIP, and suffixes", () => { expect(normalizeAddress("1234 market st.").display).toBe("1234 MARKET ST"); expect(normalizeAddress("1234 Market Street, Philadelphia, PA 19107").display).toBe("1234 MARKET ST"); expect(normalizeAddress("2140 Spruce Street Apt 4B").unit).toBe("4B"); });
it("resolves exact, marks a typo as fuzzy, and treats a condo parent as resolved with units", async () => { /* fetchMock: raw '1234 market st.' -> empty_content, normalized -> property-1234-market.md => exact, opa 883309050; '1234 Markt St' -> same page => fuzzy; '1500 Market St' -> property-1500-market.md => parent, units.count 2 */ });
it("returns no_match with variants tried after two empty_content answers", async () => {});
it("isIncomplete flags Loading placeholders and empty counted sections", () => { expect(isIncomplete(fx("li-loading.md"))).toBe(true); expect(isIncomplete(fx("li-1234-market.md"))).toBe(false); });
it("fetchAtlas retries an incomplete read and returns the complete one", async () => { /* first intercept li-loading.md, second li-1234-market.md; fake timers */ });
```

- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify they pass** (5 tests)
- [ ] **Step 5: Commit** `git commit -m "feat: address normalization and atlas resolution with incomplete-read retry"`

---

### Task 3: The four Fetch sections

**Files:**
- Create: `src/sections/types.ts`, `property.ts`, `li.ts`, `zoning.ts`, `deeds.ts`, `index.ts`
- Test: `tests/sections-fetch.test.ts`; fixtures `li-1234-market.md`, `zoning-1234-market.md`, `deeds-1234-market.md` (from `../spikes/out/philly-atlas-tabs.json` and `philly-pages.json`), `li-1234-market-changed.md` (hand-edited copy with one new permit row and one violation status changed to CLOSED)

**Interfaces:**
- `SectionAdapter = { id; label; agency; method: "fetch" | "agent"; monitorable: boolean; purpose?: string; url(ctx: { address: string; opa: string }): string; parse?(markdown: string): SectionData; goal?(ctx): string; outputSchema?: object; diff?(before: SectionData, after: SectionData): SectionEvent[] }`.
- `property.parse` → spec 4.2 `property.data` (numbers parsed, `raw` kept). `li.parse` → `licenses_inspections.data` with `buildings`, `certifications`, `permits {count, recent, all_url, depth: "recent"}`, `inspections`, `violations {count, recent, open_count}`, `appeals`. `zoning.parse` → `base_district`, `base_district_name`, `overlays`, `pending_bills`, `legislation`, `appeals`, `rcos`, `floodplain_overlay` (true when an overlay name matches `/flood/i`). `deeds.parse` → parcel fields and `documents {count, recent}`.
- `li.diff(before, after)` → events for new permit IDs, new violation IDs, violation status changes to CLOSED/COMPLIED, new inspections, new appeals, certifications whose expiry passed; row reordering produces nothing. `property.diff` → `assessment_change` when `assessed_value_usd` differs, `sale` when sale date or price differs.
- `index.ts`: `SECTIONS` ordered: property, zoning, licenses_inspections, deeds, assessment_history, tax, flood, schools; `getSection(id)`.

- [ ] **Step 1: Write the failing tests** (each parser against its fixture with exact expected values from the spike: OPA 883309050, owner SEPTA, assessed 148232900, sale 1993-09-17 price 10; permits count 155 with first recent ID EP-2026-004102; violations count 83; CMX-5 with 12 overlays and 1 zoning appeal WITHDRAWN; map registry 001S070144 with 36 documents; `li.diff` on the changed fixture yields exactly one `new_permit` and one `violation_closed`; reordering yields none)
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit** `git commit -m "feat: atlas section parsers and diffs for property, licences, zoning and deeds"`

---

### Task 4: TinyFish Agent, Browser and Monitor clients

**Files:**
- Create: `src/tinyfish/agent.ts`, `browser.ts`, `monitor.ts` (copy from `../standing/src/tinyfish/` or `../fineprint/src/tinyfish/`, keeping `startRun`, `getRun`, `downloadStepScreenshot`, `pickEvidenceStep`, `screenshotFullPage`, `createMonitor`, `updateMonitor`, `setMonitorStatus`, `deleteMonitor`, `listMonitors`), `src/db/inflight.ts`
- Test: `tests/tinyfish.test.ts`

**Interfaces:**
- `inflight.ts`: `acquireAgentSlot(db, runId): Promise<boolean>` (inserts the single row if absent or stale > 10 min), `releaseAgentSlot(db, runId)`.
- `agent.ts` adds `runAgentToCompletion(env, p: StartRunInput, opts: { pollEveryMs: number; maxWaitMs: number }): Promise<RunResult>` used inside Workflow steps (start, poll `getRun` until terminal).

- [ ] **Step 1: Write the failing tests** (slot acquire/release and staleness; `runAgentToCompletion` polls until COMPLETED with fake timers and records `agent_step` spend; 429 retry path)
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify they pass**
- [ ] **Step 5: Commit** `git commit -m "feat: TinyFish Agent, Browser and Monitor clients with the single in-flight slot"`

---

### Task 5: Repositories

**Files:**
- Create: `src/db/types.ts`, `dossiers.ts`, `sections.ts`, `parcels.ts`, `watches.ts`, `events.ts`, `publicUse.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- `dossiers.ts`: `insertDossier`, `getDossier`, `findCachedDossier(db, opa, withinHours)` (latest `complete` or `partial` with all free sections ok), `updateDossier`, `listCuratedAndWatched`, `expirePublicDossiers(db, olderThanIso)` → ids and evidence keys.
- `sections.ts`: `upsertSection`, `getSections(dossierId)`, `setSectionStatus`, `pendingAgentSections(dossierId)`.
- `parcels.ts`: `upsertParcelSection(opa, sectionId, data)`, `getParcelSection`.
- `watches.ts`, `events.ts`, `publicUse.ts`: as in the Standing plan, with `watches.kind in ("li", "property")`, `countMonitors()`.

- [ ] **Step 1: Write the failing tests** (cache window; expiry skips watched; `countMonitors` excludes expired; parcel section upsert overwrites)
- [ ] **Step 2–5** as usual; commit `git commit -m "feat: D1 repositories for dossiers, sections, parcels, watches and events"`

---

### Task 6: Dossier creation, free sections, screenshots, JSON API

**Files:**
- Create: `src/dossier/build.ts`, `src/dossier/document.ts`, `src/handlers/dossiers.ts`, `src/handlers/objects.ts`
- Modify: `src/index.ts`
- Test: `tests/dossiers.test.ts`

**Interfaces:**
- `createDossier(env, input: { address?; opa_account?; unit?; tier?; fresh?; callback_url? }, who: { admin: boolean; ipHash: string }): Promise<{ dossierId; status; outcome; estimatedCostUsd; reportUrl }>`: public caps (3 per day → 429), resolve (no_match → 200 with `outcome: "no_match"` and the variants; ambiguous → candidates), cache unless `fresh`, insert dossier, `buildFreeSections` (four `fetchAtlas` reads in parallel; each parsed and upserted with status `ok` or `empty` (page ok, no rows) or `error`; a TinyBrowser screenshot per ok section stored at `evidence/<dossier>/<section>.jpg`, with `waitUntil`), then `applyTier`: free → Agent sections upserted as `status: "pending"` with `pending: false` and `upgrade_cost_usd`; standard/deep → `startAgentSections` (Workflow instance, Task 7).
- `toDossierDocument(dossier, sections, baseUrl)` → spec 4.2 shape; `sources[]` summary; `watch` block.
- `GET /api/dossiers/:id`, `GET /evidence/:key`, `POST /api/dossiers/:id/upgrade` (public: once per IP per day; 503 `{error: "budget_paused"}` when `totalSpend >= PUBLIC_AGENT_PAUSE_USD` and the caller is public).

- [ ] **Step 1: Write the failing tests** (`fetchMock` for atlas tabs, `vi.mock` for the screenshot; a public create builds four ok sections, four pending Agent sections with `upgrade_cost_usd`, and stores four evidence objects; a condo parent resolves with `resolution: "parent"`; a second create within 24 h is `cached: true`; `fresh: true` rebuilds; the fourth public create from one IP is 429; upgrade at a seeded spend of $6 returns 503 for public and starts the Workflow for admin)
- [ ] **Step 2–5**; commit `git commit -m "feat: dossier creation with free sections, screenshots, tiers and the JSON API"`

---

### Task 7: Agent sections in a Workflow

**Files:**
- Create: `src/sections/assessmentHistory.ts`, `tax.ts`, `schools.ts`, `flood.ts`, `liDeep.ts`, `src/dossier/workflow.ts`
- Modify: `src/dossier/build.ts` (`startAgentSections`), `src/handlers/dossiers.ts` (`POST /api/dossiers/:id/deepen`)
- Test: `tests/sections-agent.test.ts`, `tests/workflow.test.ts`

**Interfaces:**
- Each Agent section: `goal(ctx)` with an explicit field list and the instruction to report `blocked: true` or `no_results: true` honestly; `outputSchema`; `parseResult(result): SectionData | null`. `assessmentHistory` targets `https://property.phila.gov/?p=<opa>` and returns `years[]`. `tax` targets the Tax Center and returns `balance_usd`, `delinquent`, `as_of`. `schools` targets the school finder and returns `catchment[]` with level, name, address, distance. `flood` targets the FEMA MSC (standard profile) and returns a zone or `no_results: true`; on `no_results` the section is `unavailable` with reason `"FEMA's map search returned no results in an automated browser"` and `manual_url`. `liDeep` targets the L&I Property History page and returns up to `DEEP_ROWS_MAX` rows per list plus `truncated`.
- `DossierAgentWorkflow.run(event: { payload: { dossierId: string; sections: string[] } }, step)`: for each section id in order, `step.do(section, { retries: { limit: 2, delay: "30 seconds" } }, async () => { acquire slot; runAgentToCompletion; parse; upsert section ok|empty|unavailable|error with evidence from the run's step screenshot; release slot })`; after the loop, set dossier `complete` (or `partial` if any section errored), notify `callback_url`. The Workflow calls only functions exported from `src/dossier/agentSteps.ts` (`runAgentSection(env, dossierId, sectionId)`), which the tests exercise directly; the Workflow class itself is verified under `wrangler dev` and recorded in `docs/build-log.md`.
- `POST /api/dossiers/:id/deepen` (admin or curated) starts a Workflow instance with `["li_deep"]`; the resulting `licenses_inspections` section gets `depth`, `rows_returned`, `truncated`.
- Spend pause: `runAgentSection` checks `totalSpend >= SPEND_PAUSE_USD` first and marks the section `unavailable` with reason `budget_paused` without calling TinyFish.

- [ ] **Step 1: Write the failing tests** (each `parseResult` against a fixture, including `fema-noresults.json` → unavailable with the exact reason; `runAgentSection` for `tax` with a mocked run stores data, evidence and `agent_step` spend, and releases the slot; a second `runAgentSection` while the slot is held waits (fake timers) rather than starting a run; deep run sets `depth: "extended"` when `rows_returned < count`)
- [ ] **Step 2–5**; commit `git commit -m "feat: serial Agent sections in a Workflow, deep tier, flood honesty, spend pause"`

---

### Task 8: The readable report

**Files:**
- Create: `src/report/render.ts`, `src/report/templates/*.ts`, `src/handlers/read.ts` (`GET /d/:id`)
- Test: `tests/report.test.ts`

**Interfaces:**
- `renderReport(doc: DossierDocument): string` → complete HTML using `design/tokens.css` inlined, the Drafting Table structure from `DESIGN.md`: wordmark and stamp, sheet index with status chips, one `sheet-panel` per section in spec order, title block (ADDRESS, OPA ACCOUNT, SHEET n OF 9, SOURCE, READ, TIER), gap sheet for `unavailable`/`error`, progress sheet for `pending`, evidence thumbnails linking to `/evidence/...`, the spend line, the JSON link, print stylesheet. No client JavaScript required to read it; a 20-line script may auto-refresh while `status === "partial"`.
- `GET /d/:id` → `text/html`, `Cache-Control: no-store` while partial, `public, max-age=300` when complete.

- [ ] **Step 1: Write the failing tests** (render the Task 6 fixture dossier: contains the resolved address, nine sheets in order, the FEMA gap sheet with the manual link, the title block fields, four evidence `<img>` with alt text naming agency and time, the spend line; a partial dossier renders the progress sheet with "sheet n of 9"; HTML passes a basic well-formedness check)
- [ ] **Step 2–5**; commit `git commit -m "feat: server-rendered dossier report in the Drafting Table world"`

---

### Task 9: Watches, Monitor webhook, events, read API

**Files:**
- Create: `src/handlers/watches.ts`, `src/handlers/webhooks.ts`, extend `src/handlers/read.ts`, `src/handlers/admin.ts`
- Test: `tests/watches.test.ts`, fixtures `tests/fixtures/webhooks/li-changed.json`, `li-loading.json`, `li-reordered.json`, `property-sale.json` (hand-built from the documented payload shape and the atlas fixtures)

**Interfaces:**
- `POST /api/dossiers/:id/watch`: caps (`countMonitors() < MAX_MONITORS`; public slots; public gets `li` only, curated and admin get `li` and `property`), `createMonitor` with the spec 4.5 purposes and a 12-hour staggered cron, `expires_at` for public → 201 `{watch_id, monitors}`. `DELETE` removes.
- `POST /hooks/monitor/:secret`: secret; `fetch_monitor_id` → watch; `changed` with incomplete text → log `incomplete`, 200; else parse with the section adapter, `diff` against `parcels` stored data, write events (one per change row, with `rows`, `before`, `after`), update the parcel section, notify `callback_url`; unchanged → spend row.
- `GET /api/events?since=&address=`, `GET /api/addresses/:opa/history`, `GET /api/sources` (from `SECTIONS` with `last_success_at`), `GET /api/export.json` (curated and watched only), `GET /api/stats`; `GET /api/dossiers/:id/nearby` (events for other watched parcels on the same block: same street name and same hundred-block).

- [ ] **Step 1: Write the failing tests** (watch creates the right monitors and respects caps; `li-changed` → exactly one `new_permit` and one `violation_closed` event with the rows; `li-loading` → no event, `incomplete` logged; `li-reordered` → no event; `property-sale` → one `sale` event with before/after; callback_url called once; export excludes unwatched public dossiers; nearby returns events from a parcel on the same block only)
- [ ] **Step 2–5**; commit `git commit -m "feat: address watches with Monitor, structured events, nearby view and read API"`

---

### Task 10: Hourly cron

**Files:** `src/cron.ts`; wire `scheduled`. **Test:** `tests/cron.test.ts`.

- `runCron(env)`: expire public watches (delete Monitor, keep events); expire unwatched public dossiers past `PUBLIC_DOSSIER_TTL_DAYS` (rows and evidence); release a stale `agent_inflight` slot; mark dossiers `failed` whose Workflow has not progressed in 30 minutes (sections still `pending` with a `workflow_id` older than that) and set those sections `error`; monitor health via `listMonitors`. Never reads a city site.

- [ ] **Step 1: Write the failing tests** (four cases, one per duty)
- [ ] **Step 2–5**; commit `git commit -m "feat: hourly cron for expiry, stale slot release, workflow timeout and monitor health"`

---

### Task 11: Demo script, runbook, README skeleton, CI, live tests

**Files:** `scripts/build-demos.mjs`, `docs/runbook.md`, `README.md`, `docs/build-log.md`, `tests/integration/*.live.test.ts`, `tests/scripts.test.ts`.

- `scripts/build-demos.mjs --base <url> --token <admin>`: for each address in `docs/demo-addresses.md` (parsed from its table), `POST /api/dossiers` with `tier: "deep"`, poll until `complete`, `POST .../watch`, print the report URLs and `/api/stats`; refuses to run if `countMonitors` would exceed 10.
- `docs/runbook.md`: D1, R2 and Workflow creation (`wrangler deploy` creates the Workflow), secrets, `PUBLIC_BASE_URL`, migrate, deploy, one live free-tier dossier for a non-demo organization-owned address as the smoke test, then `build-demos`, then the first real Monitor payload saved as a fixture.
- README skeleton: what it does, live URL placeholder, the sources table (from `/api/sources`), "How TinyFish Fetch, Agent, Browser and Monitor are used" table, the three demo report links, run locally, limits and posture (FEMA note, people in the data, no bulk).

- [ ] **Step 1: Write the failing test** (`parseDemoAddresses(markdown)` returns the three addresses and their OPA when present)
- [ ] **Step 2: Run to verify it fails**
- [ ] **Step 3: Write the script, runbook, README skeleton, integration tests**
- [ ] **Step 4: `npm run check`**
- [ ] **Step 5: Commit** `git commit -m "feat: demo builder script, runbook, README skeleton, live tests"`

---

## After Task 11

Stop here and take stock: the commit list, test counts per file, where the build differs from the plan (in `docs/build-log.md`), and the exact deploy and demo commands. No live Agent or Browser call, and no deploy, before that.

## Notes after reading the plan again

- Spec coverage: 4.1 (Task 2), 4.2 (Tasks 3, 6, 7), 4.3 (Tasks 6, 7), 4.4 (Task 8), 4.5 (Task 9), 4.6 (Tasks 6, 9), 4.7 viewer (separate plan after the report lands), 5 (Tasks 1, 5), 6 sources (Tasks 3, 7, 9), 7 (Tasks 6, 7, 9, 10), 8 (every task), 9 delivery (Task 11), 11 demos (Task 11).
- Names are defined once where listed under Produces: `normalizeAddress`, `addressVariants`, `fetchAtlas`, `isIncomplete`, `resolveAddress`, `SECTIONS`, `getSection`, `acquireAgentSlot`, `releaseAgentSlot`, `runAgentToCompletion`, `createDossier`, `buildFreeSections`, `startAgentSections`, `applyTier`, `toDossierDocument`, `runAgentSection`, `renderReport`, `runCron`, `parseDemoAddresses`.
