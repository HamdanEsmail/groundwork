# Groundwork: the site

**Goal:** Give the dossier engine its site, as specified in section 4.7 of
`docs/specs/2026-11-03-groundwork-design.md`, in the look of `DESIGN.md`.

**The model:** `design/comp-home.html` and `design/comp-dossier.html` are the screens, built by hand from one real
dossier. Their classes and structure are used exactly. The stylesheets `public/assets/site.css` and
`public/assets/dossier.css` are theirs; a rule a new screen needs is added at the end of `dossier.css` in the
same manner and listed in the build log. Nothing is restyled.

**Stack:** as the rest of the project. Pages are `hono/jsx` components rendered on the Worker. Static files are
served from `public/` through Wrangler's `assets` setting. No client framework; the small scripts in the comps
are the only scripts.

## Constraints

- No TinyFish call from a test or by hand. Tests use the existing interceptor, fixtures and seams.
- Everything from a city page or from a visitor is escaped by the renderer; only `http:` and `https:` URLs
  become links. A message shown after a redirect is chosen by a code from a fixed list, never echoed text.
- The site adds no way to spend money or write rows that the API does not already limit. Form routes call the
  same functions as the API routes, with the same limits and the same pauses.
- A count of rows shown is never presented as the count on file.
- Names of people: community organizations are listed by name only (no contact person); an appeal's free text
  is cut to 150 characters; nothing else is removed from what the official page states.
- The demo addresses and everything shown on the home come from curated or watched parcels only (spec 7).
- Fixtures are invented. No file says or implies who or what wrote it.

## Task 1: the shell, the home and a dossier

- [ ] `wrangler.jsonc`: `"assets": { "directory": "./public" }`. `public/robots.txt`, `public/favicon.svg` (the
      wordmark's G on blue, square).
- [ ] `src/site/format.ts`: `day` ("17 Sep 1993"), `stamp` ("9 Nov 2026, 17:34 UTC"), `int`, `usd`, `words`
      (cut at a word, 150), `sentence` (first letter upper, rest lower). Dates are read as UTC and never shifted.
- [ ] `src/site/layout.tsx`: the document (title, description, fonts, `/assets/site.css`, and `/assets/dossier.css`
      on every screen but the home), the top bar of inner screens, the footer of tiles with the Philadelphia
      clock. `src/site/components.tsx`: frame, strip, facts, record table, status word, sheet, evidence.
- [ ] `GET /`: the home, section by section as the comp:
      the sheet with the text cell and its form; the board; the run-in column; the nine offices, from the
      section registry (office, what it holds, read by, whether Monitor can watch it); **what changed at watched
      addresses**, the latest 10 events of curated and watched parcels as a record table (date, address, what
      changed, the sheet), or the sentence "No change has been recorded yet. Monitor reads each watched page
      twice a day."; the quiet figures, live: dossiers built, sheets read, gaps marked (sections that are
      `unavailable` or `error`), TinyFish spend; the close; the footer.
      The three examples are the demo addresses of `docs/demo-addresses.md`: each links to the newest curated
      dossier of that address when one exists, and otherwise fills the field.
- [ ] `POST /go` (form field `address`): nine digits are an OPA account, anything else an address. It creates a
      dossier as a public visitor through `createDossier` and answers 303 to `/d/:id`, also for no match. Too
      many today, the atlas not answering, and an unusable field answer 303 to `/?note=<code>#top`; the home
      shows the sentence for that code above the field. While the request runs, the button reads "Reading four
      city pages, about 40 seconds" and is disabled (script); without script the page simply waits.
- [ ] `GET /d/:id` replaces the old report with the dossier screen of the comp, in every condition:
      - **read**: title, figures, the record by date, index, sheets. Figures and lanes use what the read sheets
        hold; a figure whose sheet was not read is left out, never shown as zero.
      - **being read** (`partial`): the sheets read so far, "Being read" on the pending ones with the office
        named, and a refresh every 10 seconds by `meta` refresh (no script needed). No refresh once complete.
      - **no match / ambiguous / failed**: the typed text as the title in the same place, what was tried, how
        to resolve it, the candidates or units as links that fill the form, the link to the city atlas, and
        the address form again.
      - **a spelling that was matched** (`resolution: "fuzzy"`): a line under the title: "You typed X. The city
        holds Y."
      - **a building with units** (`resolution: "parent"`): a line under the title: "This is the record of the
        whole building. It holds N units." and the units as links that start a dossier for the unit's account;
        when the list could not be read, the link to the city's list instead.
      - **a sheet that could not be read**: its place in order, the status word, the reason in a sentence
        (`empty_content` and `incomplete_after_retries`: "The page did not finish loading in four reads.";
        a budget pause: the stored sentence; anything else: "The page could not be read."), the link to check
        by hand.
      - **sheets not asked for**: the one washed sheet. Its button posts to `/d/:id/upgrade`.
      - the five Agent sheets when read (assessment history, tax, flood, schools, the full history), each with
        facts and record tables made from its stored data, in the manner of the four in the comp.
      - evidence only when the section has an evidence key.
      Cache headers as now: `no-store` while partial, five minutes once complete.
- [ ] `POST /d/:id/upgrade` and `POST /d/:id/watch`: forms that call the same functions as
      `POST /api/dossiers/:id/upgrade` and `POST /api/watches` (move the shared logic out of the handlers
      rather than copying it), then answer 303 to `/d/:id?note=<code>`. The dossier shows the sentence for the
      code under the title: started, already running, the daily limit, the budget pause, no free watch slot,
      now watched until a date.
- [ ] Remove `src/report/` once nothing uses it. Move what its tests prove to tests of the new screen.
- [ ] Tests: each condition above renders its sentences; hostile text in the address, in a city field and in a
      `note` is escaped or ignored; `POST /go` redirects for a match, a no match, the limit and the atlas being
      down; the forms respect the limits; the home shows no public one-off lookup.
- [ ] `npm run check`. Commit `site: the home and the dossier`.

## Task 2: the other screens

- [ ] `GET /watchlist`: watched addresses (curated and public), which sheets Monitor watches, the last check,
      the last event, when a public watch ends; the public slots in use; the form to open a dossier.
- [ ] `GET /sources`: the nine offices, how each is read, what Monitor can watch, when each was last read
      successfully, and the note on the flood map (the map centre refuses automated access; the sheet says so
      and links the manual lookup).
- [ ] `GET /about`: how Fetch, Agent, Browser and Monitor are used with calls and spend from the ledger; the
      limits from `src/core/limits.ts`; what is kept and for how long; the picture credits from
      `design/credits.json`; the licence.
- [ ] Not found (page and dossier). Meta description and social tags on every screen; a social image (1200 by
      630) made from the home's first screen; print styles checked on a dossier.
- [ ] Tests for each screen's facts and for the not-found answers. `npm run check`. Commit
      `site: watchlist, sources, about`.
