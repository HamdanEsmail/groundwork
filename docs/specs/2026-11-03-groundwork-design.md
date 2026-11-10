# Groundwork: design

*Working name (what you do before you buy, build or renovate). Submission for the TinyFish Student Bounty Drop 002 "Property Dossier" bounty. Written 2026-11-03. Deadline 2026-11-17. City: Philadelphia, PA.*

## 1. Intent

Before anyone buys, builds on or renovates a property, someone digs through city and county websites by hand: the assessor, the permits office, zoning, deeds, tax balances, flood maps, schools. Groundwork takes a Philadelphia address (or an OPA account number) and returns a property dossier pulled live from the city's official sites with TinyFish: assessment and last sale, permits, inspections, violations and appeals, zoning district and overlays, recorded deeds, real estate tax balance, FEMA flood zone, catchment schools. Every item carries its source link, the time it was read, and a screenshot of the page as read. Missing or unavailable records are flagged, never guessed. TinyFish Monitor watches an address for new permits, violations, sales or assessment changes.

Judges weigh: how many official sources it pulls from and how well it combines them; accuracy with a link to prove every record; coverage across many addresses, not a handful; honesty about gaps; Monitor adding real value such as alerting on a new permit at or near the address. "A report an agent, buyer or contractor would trust before signing anything."

Approval criteria, verbatim: TinyFish does the core retrieval on live official sites; records are accurate to the source; works for any address in the areas supported, not a hardcoded few; missing records are flagged clearly rather than guessed; goes beyond a single listing page or a map lookup. Submission requirements: takes an address or parcel number; pulls from at least three official sources; outputs a structured dossier (JSON plus a readable report) with every item linked to its source; demo on at least three addresses; short explanation of how Agent, Fetch and Monitor are used.

## 2. Goals, non-goals, anti-goals

**Goals**
- Nine official Philadelphia sources per address (section 6), four of them read for free with TinyFetch, the rest with TinyAgent. Any Philadelphia address or OPA account, with an address-resolution contract for sloppy input, condos and no-match.
- A dossier that is both a JSON document and a readable report at a stable, shareable URL, in the family design, with an evidence line (source link, read time) beside every item and a screenshot per source.
- Honest gaps: every section has a status (`ok`, `empty`, `unavailable`, `pending`, `error`, `skipped`) (amended 3 Nov 2026) with the reason and the manual link; a dossier is never "complete" by omission.
- Monitor watches per address: new permits, inspections, violations and appeals from the licences page; sale and assessment changes from the assessment page. Events with before and after, in the UI, the API and an optional callback.
- Depth on demand: the default dossier is free-plus-three-Agent-runs; the full permit and violation history is one more run the user asks for, with the cost shown.
- Budget about $4 of TinyFish wallet for build, three demo dossiers and the live run.

**Non-goals**
- Cities other than Philadelphia (the adapter layer allows more later; none is built now).
- Valuation, price prediction, comparables, or any opinion. Groundwork reports what the city holds.
- Documents behind paywalls (non-watermarked deed copies) or logins.
- A PDF export. The HTML report prints well; PDF is a later nicety.

**Anti-goals**
- Filling a section from a non-official source, or from memory, when the official site fails.
- Presenting the five most recent permits as "the permits" without the count and the link to the rest.
- Our own polling. Monitor is the only trigger for events.
- Creating an event from a half-loaded page (the atlas sometimes returns "Loading…" placeholders).
- Bypassing a site that refuses automated access. FEMA's map centre blocked the standard browser profile; the dossier says so and links the manual lookup.

## 3. Constraints and verified facts

Verified on 2026-11-03 with real calls; scripts and responses in `../spikes/` (`spike-philly.mjs`, `spike-philly-agent.mjs`, `spike-philly2.mjs`, `out/philly.json`, `out/philly-atlas-tabs.json`, `out/philly-pages.json`, `out/philly-li.json`, `out/philly-fema.json`). Test address: 1234 Market St (SEPTA headquarters, OPA account 883309050).

**City atlas (`https://atlas.phila.gov/<address>/<tab>`), read for free with TinyFetch**
- `/property`: OPA account #, OPA address, owners, mailing address, building description, improvement area, year built, assessed value, homestead status, sale date and price (884 chars). Source: Office of Property Assessment.
- `/li`: building IDs and certifications, **Permits (155)** with the 5 most recent (date, ID, description, status) and "See all permits at L&I Property History", zoning permit documents, **Inspections (99)**, **Violations (83)** with the most recent rows (date, ID, description, status), L&I appeals (4,802 chars). Source: Department of Licenses & Inspections.
- `/zoning`: base district (CMX-5), pending bills, overlays (12) with code sections, record of zoning legislation, zoning appeals with status, Registered Community Organizations (2,987 chars). Source: Planning and Development.
- `/deeds`: map registry #, parcel status, origination date, air rights, condo flag, perimeter and area, recorded documents (ID, date, type, grantor, grantee) from 1999 forward (2,056 chars). Source: Department of Records.
- `/voting`, `/city-services` render too (not used). `/nearby` and `/licenses-inspections` return the page shell only (JavaScript), as does the bare `/<address>` path (`empty_content`).
- **Loading race**: two fetches of `/li` ninety seconds apart returned 57 lines with "Loading permits…" placeholders and then 100 lines with full tables. Any read that contains a `Loading` placeholder or a section header with no rows where a count says there are rows is incomplete and must be retried (up to 3 times, 10 s apart); a Monitor payload in that state is ignored, never an event.
- **Address handling**: "1234 Market Street" resolves to the same page as "1234 Market St"; the typo "1234 Markt St" also resolves (the atlas is fuzzy); "1234 market st." (trailing period) and "1234 Market St Philadelphia PA 19107" (city and ZIP appended) return `empty_content`. The resolver strips those.
- `https://property.phila.gov/?p=<address>` (OPA's own page, 2,939 chars) renders the tax estimator, the headings for Real Estate Tax Balance and Valuation History, and the 2026 and 2027 assessment-year selector, but the valuation table and balance load with JavaScript; it also links the Philadelphia Tax Center for the bill. The assessment history by year is therefore an Agent read (section 6).

**TinyAgent** (`out/philly-li.json`): with the standard browser profile and an explicit goal, Agent searched `https://li.phila.gov/property-history/search` for the address and returned `page_url: https://li.phila.gov/property-history/search?address=1234%20MARKET%20ST`, `permits_count: 155`, five permits with numbers, types and dates, `violations_count: 83`, three violations, `licenses_listed: true`, in 9 steps, 111 s, $0.14. That page is GET-shaped but renders only its shell for TinyFetch (99 chars), so full lists are Agent reads and are not Monitor targets; the atlas `/li` page is the Monitor target. Explicit goals with field lists work; `output_schema` is accepted. Cap at `max_steps: 14` ($0.22). The account allows 2 concurrent runs **shared with the Fineprint and Standing builds**. **A rule I keep across my builds on this account: each build keeps at most one Agent run in flight at a time.** Groundwork therefore runs its Agent sections serially, one after another, as steps of a Cloudflare Workflow per dossier (durable, retried, survives the 202); the dossier is `partial` while they run and the report shows each pending section as "reading… (2 of 4)" with the sections that are done already visible. A 429 inside a step waits 60 s and retries up to 3 times. Realistic timing: about 2 minutes per Agent section, so a standard dossier completes in 6 to 8 minutes after its free core appears within seconds. That is shown, not hidden.

**FEMA Flood Map Service Center** (`out/philly-fema.json`, `out/philly-fema2.json`): two standard-profile Agent runs (13 and 15 steps, $0.45 together), the second with an autocomplete-aware goal, typed the address, waited for suggestions, clicked Search, and the page stayed in its initial state: no results, no autocomplete, no error, no block page. This is not a refusal; the map centre's search does not respond in an automated browser. The flood section therefore reports `unavailable` with the reason "FEMA's map search returned no results in an automated browser (2 attempts on 2026-11-03)" and the manual link `https://msc.fema.gov/portal/search?AddressQuery=<address>`. The builder may try FEMA's other official interface, the National Flood Hazard Layer viewer (`https://hazards.fema.gov/femaportal/wps/portal/NFHLWMS`), once with the standard profile during the build; if it returns a zone, it becomes source 8 with that URL. No stealth profile against either. The flood probe runs at most once per address per 7 days and only on the standard and deep tiers. The atlas `/zoning` overlays are scanned for a floodplain overlay as a free, official secondary signal, labelled as zoning, not as a FEMA determination.

**School District school finder** (`https://webapps1.philasd.org/school_finder/`): renders "Loading…" for TinyFetch; an Agent read. **Philadelphia Tax Center** (`https://tax-services.phila.gov/_/`): a JavaScript app; an Agent read ("Search for a property" by OPA account or address → real estate tax balance and any delinquency). Both verified only as reachable; their Agent goals are written and tested in the build with one run each, recorded as fixtures.

**TinyBrowser**: raw CDP screenshot from the Worker, verified in `../spikes/worker-shot/src/index.js`, $0.002. Every free-Fetch section gets one; Agent sections use the run's step screenshot.

**TinyFish Monitor**: Page monitors verified (`../spikes/spike-monitor.mjs`); webhooks on every scheduled run with `outcome`, `diff`, `judgment`; `PATCH` needs `schedule_cron`; $0.005 per check; **Groundwork may hold at most 10 monitors** (account allocation: Fineprint 24, Standing 10, Groundwork 10, Site to MCP 2, spare 4).

**Cloudflare**: same stack and free-plan limits as the sibling builds; account ready; working token in `../.cloudflare.env`.

## 4. Architecture

One Cloudflare Worker (Hono) with D1 and R2, serving the API, the Monitor and Agent webhook receivers, the HTML report, and the React viewer as static assets. Same conventions and design system as Fineprint and Standing (`DESIGN.md` at the repo root, accent `#1d4ed8`, stamp ON FILE).

```
POST /api/dossiers {address | opa_account}
   |  resolve address (4.1): atlas /property via TinyFetch with raw then normalized input
   v
 resolved (opa_account, canonical address) | ambiguous (several parcels) | no_match
   |
   v  free sections, in parallel, each with its own status: property, li, zoning, deeds  (TinyFetch, retry on Loading)
   v  TinyBrowser screenshot per free section -> R2 evidence/<dossier>/<section>.jpg
   v  Agent sections, started as async runs with callback: assessment_history, tax, schools, flood
   v  dossier status: partial until every section is terminal (ok | empty | unavailable | error | skipped)
 GET /api/dossiers/:id  (JSON)      GET /d/:id  (readable report, stable URL)
 POST /api/dossiers/:id/deepen  -> one Agent run: full L&I permit and violation lists
 POST /api/dossiers/:id/watch   -> Monitors on atlas /li and /property
 POST /hooks/monitor/<secret>   -> changed? -> re-read section -> structured event
```

**Amended 3 Nov 2026:** A dossier is complete when every section is terminal, with `has_errors` indicating any section error. It is failed only when resolution fails or every requested section errors.

### 4.1 Address resolution contract

Input `address` (string) or `opa_account` (9 digits).
1. Normalize: trim; drop a trailing `, Philadelphia`, `Philadelphia`, `PA`, `Pennsylvania` and a 5 or 9 digit ZIP; drop trailing punctuation; collapse whitespace; map suffixes to the city's forms (`Street→St, Avenue→Ave, Boulevard→Blvd, Road→Rd, Drive→Dr, Lane→Ln, Place→Pl, Court→Ct, Terrace→Ter, Parkway→Pkwy, Square→Sq, North→N, South→S, East→E, West→W`); uppercase for display, keep the unit (`#4B`, `Unit 4B`, `Apt 4B`) separately.
2. TinyFetch `https://atlas.phila.gov/<encoded raw input>/property`; on `empty_content`, retry with the normalized form; on a second `empty_content`, `outcome: "no_match"` with `variants_tried[]` and the manual atlas link.
3. Read the H1 address and the `OPA Account #`. **Condominiums and multi-parcel lots never block the dossier.** When `/property` says `There are N condominium units at this address` (1500 Market St shows this with a full parent-parcel record) or `/deeds` or `/zoning` say `There are N active parcels`, the dossier resolves to the **parent parcel** with `resolution: "parent"`, a `units: { count: N, list: [...] | null, list_url }` field, and a banner in the report: "This address has N condominium units. The assessment and sale below are the parent parcel's; for a unit, repeat with its OPA account or unit number." The unit list is read from the atlas condominiums tab if TinyFetch renders it (one free check in the build); otherwise `list` is null and one optional Agent run fills it on request. A supplied `unit` or `opa_account` resolves to that unit's own parcel instead. `outcome: "ambiguous"` is reserved for a search that returns several *different* addresses (the atlas search-results case), with `candidates[]` and `how_to_resolve`.
4. If the resolved H1 differs from the normalized input by more than suffix and case (the atlas is fuzzy: "Markt" resolved to "MARKET"), return `resolved_to` and `resolution: "fuzzy"` so the report shows "You searched X, the city matched Y". The dossier still builds.
5. `opa_account` input goes to `https://atlas.phila.gov/<account>/property` (the atlas accepts OPA accounts in the search path; verified in the build with one free Fetch; if not, Agent resolves it once).

### 4.2 Sections and the dossier document

**Amended 3 Nov 2026:** The document includes nine sections; a section outside the selected tier is `skipped` and carries its upgrade cost.

Each section is one module implementing `SectionAdapter`: `id`, `label`, `source` (agency name), `method` (`fetch` | `agent`), `url(ctx)`, `parse(markdown)` or `goal(ctx)` + `outputSchema`, `monitorable: boolean`, `purpose` (for Monitor), `diff(before, after)` for events. The dossier is:

```json
{
  "dossier_id": "…", "address": { "input": "1234 market street", "resolved": "1234 MARKET ST, PHILADELPHIA, PA 19107-3721", "opa_account": "883309050", "resolution": "exact" | "fuzzy" },
  "status": "complete" | "partial" | "failed", "has_errors": false, "tier": "standard", "cached_from": null, "created_at": "…", "completed_at": "…", "spend_usd": 0.47, "cached": false,
  "sections": {
    "property":   { "status": "ok", "source": "Office of Property Assessment", "source_url": "…", "checked_at": "…", "method": "fetch", "evidence_url": "…", "data": { "owners": ["SEPTA"], "building_description": "OFFICE BLDNG - High Rise", "year_built": 1973, "improvement_area_sqft": 723780, "assessed_value_usd": 148232900, "homestead": false, "sale_date": "1993-09-17", "sale_price_usd": 10 } },
    "licenses_inspections": { "status": "ok", "depth": "recent" | "extended" | "full", "rows_returned": null, "truncated": null, "…": "…", "data": { "buildings": [...], "certifications": [...], "permits": { "count": 155, "recent": [{ "date": "2026-09-15", "id": "EP-2026-004102", "description": "Electrical Permit", "status": "Issued" }], "all_url": "https://li.phila.gov/property-history/search?address=1234%20MARKET%20ST", "depth": "recent" | "full" }, "inspections": { "count": 99, "recent": [...] }, "violations": { "count": 83, "recent": [...], "open_count": 4 }, "appeals": { "count": 3, "recent": [...] } } },
    "zoning":     { "…": "…", "data": { "base_district": "CMX-5", "base_district_name": "Center City Core Commercial Mixed-Use", "overlays": [{ "name": "/CTR Center City Overlay District", "code_section": "14-502(2)" }], "pending_bills": [...], "legislation": [...], "appeals": [...], "rcos": [...], "floodplain_overlay": false } },
    "deeds":      { "…": "…", "data": { "map_registry": "001S070144", "parcel_status": "Active", "area_sqft": 48148, "is_condo": false, "documents": { "count": 36, "recent": [{ "id": "54466485", "date": "2025-09-11", "type": "CONTINUATION", "grantor": "…", "grantee": "…" }], "all_url": "…" } } },
    "assessment_history": { "status": "ok", "method": "agent", "data": { "years": [{ "year": 2027, "market_value_usd": 0, "taxable_land_usd": 0, "taxable_improvement_usd": 0, "exempt_usd": 0 }] } },
    "tax":        { "status": "ok" | "unavailable", "method": "agent", "data": { "balance_usd": 0, "delinquent": false, "as_of": "…" } },
    "flood":      { "status": "unavailable", "reason": "FEMA refused automated access", "manual_url": "https://msc.fema.gov/portal/search?AddressQuery=…", "data": null },
    "schools":    { "status": "ok", "method": "agent", "data": { "catchment": [{ "level": "elementary", "name": "…", "address": "…", "distance_miles": 0.4 }] } },
    "li_deep": { "status": "skipped", "source": "Department of Licenses & Inspections", "source_url": "...", "checked_at": null, "method": "agent", "evidence_url": null, "manual_url": "...", "upgrade_cost_usd": 0.224, "data": null }
  },
  "watch": null | { "watch_id": "…", "monitors": ["li", "property"] },
  "sources": [{ "id": "property", "agency": "…", "url": "…", "checked_at": "…", "status": "ok" }]
}
```

Every number keeps its raw string in `data.raw` for the section (`"$148,232,900"`), so the report can show the city's own formatting beside the parsed value. Dates are ISO. Nothing is inferred: `open_count` is counted from rows whose status is `OPEN`, not estimated.

### 4.3 Depth versus cost

| Tier | What runs | Cost (9 to 14 steps per run) | Who gets it |
|---|---|---|---|
| Free core | `property`, `licenses_inspections` (recent rows and counts), `zoning`, `deeds`, four TinyBrowser screenshots | $0.008 | every dossier, including every public one by default |
| Standard | plus Agent, serially: `assessment_history`, `tax`, `schools`; `flood` probe when enabled | $0.45 to $0.90 | admin and curated by default; public by the "read the rest" button, once per IP per day |
| Deep | plus one Agent run on L&I Property History for the extended permit, inspection and violation lists | about $0.20 more | admin; the three demo dossiers |

**What "deep" promises.** One run, capped at 14 steps, reads up to 100 rows per list from L&I Property History and reports `rows_returned` beside `count`. `depth` is `recent` (atlas rows), `extended` (the deep run returned fewer rows than `count`, with `truncated: true`) or `full` (every row). The report never says "all permits" unless `depth` is `full`; otherwise it says "155 permits, 100 shown, the rest at L&I" with the link. If the page paginates, the agent reports `truncated: true` rather than clicking through.

**Budget rule.** The build targets about $5 total for the live window: three deep demo dossiers (about $2.50), ten monitors at 12 hours for two weeks (about $1.40), and about $1 of public "read the rest" upgrades. `PUBLIC_AGENT_PAUSE_USD = 6`: once total spend passes $6, public upgrades stop and their Agent sections report `unavailable` with the reason "budget paused for public requests; the free core is complete"; admin and curated dossiers continue. `SPEND_PAUSE_USD = 8` stops every Agent and Browser call. Both thresholds are visible on `/api/stats` and the footer.

The report says which tier it is and what the next tier adds and costs. Dossiers are cached 24 hours by resolved OPA account; `fresh: true` rebuilds and shows the cost. Public callers: 3 dossiers per IP per day; admin unlimited.

### 4.4 Readable report (`GET /d/:id`)

Server-rendered HTML in the family design (no client JS needed to read it): a stamped header with the resolved address, OPA account, dossier time and tier; a sources strip (nine agencies, each with its status chip); then one stamped card per section in a fixed order (property, zoning, licences and inspections, deeds, assessment history, tax, flood, schools), each with its evidence line (source link, "read at …", method) and a thumbnail of the evidence screenshot that opens full size; gaps rendered as a card with the reason and the manual link; a footer with the spend line and the JSON link. Print stylesheet included. Stable URL, cacheable, shareable with judges.

### 4.5 Watching an address with Monitor

- `POST /api/dossiers/:id/watch` creates a Page monitor on the atlas `/li` page, every 12 hours, `purpose`: "A permit, inspection, violation, appeal or building certification was added or changed status. Ignore timestamps, ordering and layout." Admin and curated watches also get a Page monitor on `/property` with purpose "The assessed value, owner, sale date or sale price changed." Public watches get `/li` only and expire after 7 days. A visitor may start one watch a day. A watch a visitor starts makes nothing public: it is listed on the watchlist for that visitor only (amended 10 Nov).
- Monitor webhook: `changed` → if the payload text contains a `Loading` placeholder or a section with a count but no rows, ignore (log `incomplete`); else parse with the section adapter, diff against the stored section (`new_permit`, `new_violation`, `violation_closed`, `new_inspection`, `new_appeal`, `certification_expired`, `assessment_change`, `sale`), write events with the rows that changed, update the stored section, notify `callback_url` if given. Unchanged → spend row only.
- "Near the address": the dossier's `nearby` view lists events for other public addresses (curated, or watched with the admin token) within the same street block (block number and street from the resolved address). No extra monitors; it is a query over existing events.
- Allocation of the 10 monitors: three curated demo addresses × (`li` + `property`) = 6; four public `li` watch slots = 4. No spare; the cap is enforced.

### 4.6 API surface

| Method | Path | Returns |
|---|---|---|
| POST | `/api/dossiers` | body `{address?, opa_account?, unit?, tier?: "free" \| "standard" \| "deep", fresh?: boolean, callback_url?}` → 202 `{dossier_id, status, outcome: "resolved" \| "ambiguous" \| "no_match", estimated_cost_usd, report_url}` |
| GET | `/api/dossiers/:id` | the dossier document (4.2), `status: partial` while Agent sections run |
| GET | `/d/:id` | the readable report |
| POST | `/api/dossiers/:id/deepen` | starts the deep run → 202 with cost |
| POST / DELETE | `/api/dossiers/:id/watch` | create or remove monitors |
| GET | `/api/events?since=&address=` | events of curated addresses and addresses watched with the admin token |
| GET | `/api/addresses/:opa/history` | the dossiers I added and the events for one public parcel; never a visitor's dossier |
| GET | `/api/sources` | the nine sources with method, monitorable flag, last success time |
| GET | `/api/export.json` | curated dossiers, and admin dossiers of public parcels, with events and absolute evidence URLs |
| GET | `/api/stats` | dossiers, sections by status, watches, events by kind, spend by kind, cost per dossier |
| GET | `/evidence/:key` | R2 object |
| POST | `/hooks/agent/:secret`, `/hooks/monitor/:secret` | TinyFish callbacks |

### 4.7 Viewer (behavior; visual world is the family DESIGN.md)

- **Home**: the address form with three example chips (the demo addresses), the "what changed at watched addresses" feed, stat blocks (dossiers built, sources read, gaps flagged, spend).
- **Dossier**: the report (4.4) with a "watch this address" button, a "deepen" button with the price, and the JSON link.
- **Watchlist**: the addresses watched with the admin token, for everyone, with last check and last event; a visitor's own watch, for that visitor only, with the day it ends.
- **Sources**: the nine agencies, how each is read, which are monitorable, the FEMA note.

## 5. Data model (D1)

```
dossiers   id, address_input, address_resolved, opa_account, unit, resolution, outcome, tier, status, cached_from, ip_hash,
           added_by (public|admin|curated), created_at, completed_at, spend_usd, expires_at
sections   dossier_id, section_id, status, method, source_url, checked_at, evidence_key, data (json), raw_key, run_id, error, spend_usd,
           PRIMARY KEY (dossier_id, section_id)
parcels    opa_account PK, address_resolved, last_section_data (json per section for diffing), updated_at
watches    id, opa_account, kind (li|property), monitor_id, added_by, callback_url, expires_at, status, created_at
events     id, opa_account, kind, summary, rows (json), before (json), after (json), source_url, monitor_run_id, at, notified_at
spend      id, kind, amount_usd, ref, at
public_use ip_hash, day, dossiers, watches
```

## 6. Sources at launch (the page the product shows)

| # | Source | Agency | Read with | Monitorable | Notes |
|---|---|---|---|---|---|
| 1 | Property assessment and sale | Office of Property Assessment (atlas `/property`) | Fetch | yes | owner, building, assessed value, last sale |
| 2 | Licences, permits, inspections, violations, appeals | Licenses & Inspections (atlas `/li`) | Fetch | yes | recent rows and counts; full lists via source 3 |
| 3 | Full permit and violation history | Licenses & Inspections (L&I Property History) | Agent | no | deep tier |
| 4 | Zoning district, overlays, appeals, RCOs | Planning and Development (atlas `/zoning`) | Fetch | optional | floodplain overlay flagged if present |
| 5 | Parcel and recorded deeds | Department of Records (atlas `/deeds`) | Fetch | no | documents from 1999 |
| 6 | Assessment history by year | Office of Property Assessment (property.phila.gov) | Agent | no | the valuation table loads with JavaScript |
| 7 | Real estate tax balance | Department of Revenue (Philadelphia Tax Center) | Agent | no | by OPA account |
| 8 | Flood zone | FEMA (Map Service Center; NFHL viewer as the alternative interface) | Agent (standard profile) | no | the map centre's search returned no results in an automated browser on 2026-11-03 (two attempts); reported as unavailable with the manual link unless the NFHL viewer works |
| 9 | Catchment schools | School District of Philadelphia (school finder) | Agent | no | elementary, middle, high |

Not used, with reasons shown on the Sources page: the atlas `/nearby` tab (JavaScript only, replaced by the events-based nearby view); Philly311 (requests are private by policy); PhilaDox non-watermarked deeds (paid subscription).

## 7. Security and safety

- Secrets as Worker secrets; webhook paths carry the secret; callbacks matched to known run and monitor ids.
- Caps in one constants file: `AGENT_MAX_STEPS = 14`, `MAX_MONITORS = 10`, `PUBLIC_DOSSIERS_PER_IP_PER_DAY = 3`, `PUBLIC_WATCH_SLOTS = 4`, `PUBLIC_WATCH_TTL_DAYS = 7`, `PUBLIC_WATCHES_PER_IP_PER_DAY = 1`, `CACHE_HOURS = 24`, `FLOOD_RETRY_DAYS = 7`, `FETCH_RETRY_ON_LOADING = 3`, `SPEND_PAUSE_USD = 8`.
- Public dossiers that are not watched expire after 7 days (rows and evidence).
- **People in the data.** Owner names, deed grantors and grantees, and appeal narratives are public city records and are part of a property dossier; Groundwork shows them exactly as the city shows them, each with its source link, and stores nothing about a person beyond what those records contain. Groundwork collects nothing about the person asking except a hashed IP for rate limits.
- **Who appears in demos, the README and the export.** Only properties whose atlas owner is an organization (a company, institution or public body), never a private individual. The three demo addresses satisfy this (SEPTA; Frederick Douglass Apartments; Trustees of the University of Pennsylvania). `/api/export.json` and the home feed include curated dossiers and the dossiers I added of addresses watched with the admin token; a watch a visitor starts publishes nothing, so a visitor's one-off lookup of a private home never appears anywhere public (amended 10 Nov). I check each demo address against this rule before it goes in the README.
- No bulk endpoint. No stealth profile against any source in this build.

## 8. Testing

- Unit tests: address normalization and the resolution contract (fuzzy, ambiguous, no-match); every section parser against the recorded atlas markdown (`out/philly-pages.json`, `out/philly-atlas-tabs.json`) including the `Loading` placeholder detection; section diffs (new permit, closed violation, assessment change, no change on reordering); caps; the Monitor webhook incomplete-payload guard.
- Fixtures are real: the spike outputs plus the first real Agent results for sources 6, 7, 9 and the first real Monitor payloads.
- Tests never call TinyFish. One opt-in integration test per Agent source.
- `npm run check` = typecheck, tests, `wrangler deploy --dry-run`; GitHub Actions on push.

## 9. Delivery order

1. Scaffold, schema, address resolution, the four Fetch sections with parsers and screenshots, the dossier document and JSON API, the HTML report. Deploy. Build the three demo dossiers at the free tier and start their six monitors (the clock starts).
2. Agent sections (assessment history, tax, schools, flood with the honest-unavailable path), the deep tier, caching, callbacks, events from Monitor webhooks, nearby view, sources endpoint, export and stats.
3. Viewer on the family design system; README with the sources table, "how TinyFish Agent, Fetch, Browser and Monitor are used", the three demo dossiers linked, the monitor log, a demo GIF; post drafts.

I start live Agent calls for one build at a time: Fineprint and Standing share this account's concurrency.

## 10. Left to the builder

- Exact Agent goal wording for sources 3, 6, 7, 8, 9, as long as each names its fields and tells the agent to stop and report `blocked` on an access-denied page.
- Whether `opa_account` resolves directly in the atlas path (one free Fetch decides).
- Parser details for each atlas tab; the H1-versus-input fuzzy threshold (a Levenshtein ratio over the street name is fine).
- Router, project layout, report templating approach (a server-rendered template is expected, not a client bundle).

## 11. Demo addresses

Three, chosen on 2026-11-03 by rule (I chose to pick by rule) from free Fetch reads of fifteen candidates, all organization-owned, and at least two with ongoing inspections so Monitor has a real chance of catching activity inside the window: (1) 1234 Market St, SEPTA's headquarters, commercial high-rise with 155 permits, 83 violations and fire-safety inspections that failed on 2026-10-19 (re-inspections expected); (2) 5600 Germantown Ave, Frederick Douglass Apartments, low-rise residential with 66 violations and a permit issued 2026-04-29; (3) 4001 Walnut St, a supermarket owned by the University of Pennsylvania's trustees, with 4 open violations and a permit issued 2026-07-06. Alternates and the full scoring are in `docs/demo-addresses.md`.

## 12. Repository conventions

Same as the sibling builds: TypeScript, ESM, exact pins, `npm run check`, `.dev.vars.example`, MIT, `docs/` with this design and the plan, `artifacts/` for screenshots and the demo GIF, README opening with what it does, the live URL and the "How TinyFish is used" table. `DESIGN.md` and `design/tokens.css` from `../family/` with the Property Dossier accent. Private on GitHub until submission day.

## 13. Amendments, 10 November

What the live site taught, set against the sections above.

- **4, the Workflow.** One instance for each Agent section, not one for the dossier. The Workers free plan allows an invocation 50 requests to other hosts; one section's start, polls (10 s apart) and two final reads fit, five sections did not. A section that finds the Agent slot taken answers "busy" and the instance sleeps 20 s (`step.sleep`) before asking again, at most 90 times. Every instance runs the finish step; only the one that moves the dossier out of `partial` posts the callback.
- **4.2 and 4.6, the document and the API.** `POST /api/dossiers/:id/retry` (admin) reads again the sections that ended in error, all of them or those named. A section whose run was paid for and not read (`agent_poll_failed`, `agent_timeout`, with a run id) is read from that run. The document carries `gaps` (sections asked for and not read) and, on each of those, `reason_text`.
- **4.1, address resolution.** A condominium building with a heading, a unit count and no assessment record of its own answers `ambiguous` with its units, or resolves the unit that was named.
- **6, sources.** FEMA's search is given the city and state and 6 steps. An Agent result with nothing in it is not stored as read: a valuation table of empty rows is `unreadable_result`, a permit history with counts and no rows is `rows_not_read`.
- **11, demo addresses.** Read in full on 10 November; their report links and what each returned are in the README.
