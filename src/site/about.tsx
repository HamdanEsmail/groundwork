// How TinyFish is used, the public limits, what is kept, picture credits, the
// licence, and the public JSON routes. Spend figures come from the ledger.
import credits from "../../design/credits.json";
import {
  AGENT_MAX_DURATION_SECONDS,
  AGENT_MAX_STEPS,
  AGENT_SECTION_MAX_USD,
  CACHE_HOURS,
  CURATED_ADDRESSES,
  DEEP_ROWS_MAX,
  FETCH_RETRY_DELAY_MS,
  FETCH_RETRY_ON_LOADING,
  FLOOD_RETRY_DAYS,
  MAX_MONITORS,
  PUBLIC_AGENT_PAUSE_USD,
  PUBLIC_DOSSIER_TTL_DAYS,
  PUBLIC_DOSSIERS_PER_IP_PER_DAY,
  PUBLIC_UPGRADES_PER_IP_PER_DAY,
  PUBLIC_WATCHES_PER_IP_PER_DAY,
  PUBLIC_WATCH_SLOTS,
  PUBLIC_WATCH_TTL_DAYS,
  SPEND_PAUSE_USD,
} from "../core/limits";
import { Frame } from "./components";
import { int, usd } from "./format";
import { InnerPage, SheetBlock } from "./inner";
import type { ToolSpend } from "./query";

const TONES = ["s1", "s2", "s3", "s4"] as const;

const CAPTURES = [
  { src: "/assets/captures/market-licences.jpg", alt: "The city's licences and inspections page for 1234 Market St as it was read", strip: "Licences, 1234 Market St", pos: "0 0" },
  { src: "/assets/captures/market-deeds.jpg", alt: "The city's deeds page for 1234 Market St as it was read", strip: "Deeds, 1234 Market St", pos: "0 0" },
  { src: "/assets/captures/germantown-assessment.jpg", alt: "The city's assessment page for 5600 Germantown Ave as it was read", strip: "Assessment, 5600 Germantown", pos: "0 0" },
  { src: "/assets/captures/germantown-zoning.jpg", alt: "The city's zoning page for 5600 Germantown Ave as it was read", strip: "Zoning, 5600 Germantown", pos: "0 0" },
  { src: "/assets/captures/walnut-zoning.jpg", alt: "The city's zoning page for 4001 Walnut St as it was read", strip: "Zoning, 4001 Walnut St", pos: "0 0" },
  { src: "/assets/captures/walnut-assessment.jpg", alt: "The city's assessment page for 4001 Walnut St as it was read", strip: "Assessment, 4001 Walnut St", pos: "0 0" },
];

const API_ROUTES = [
  { route: "POST /api/dossiers", line: 'Starts a dossier from {"address": "1234 Market St"} or {"opa_account": "883309050"}. Answers 202 with its id and report link; an address the city cannot place answers 200 with status "failed" and how to resolve it.' },
  { route: "GET /api/dossiers/:id", line: 'One dossier, every sheet and its source link. "gaps" names the sheets that were asked for and not read; each of those carries "reason" and "reason_text".' },
  { route: "POST /api/dossiers/:id/upgrade", line: "Reads the four remaining sheets of a free dossier with TinyFish Agent. Once a day from one place." },
  { route: "POST /api/dossiers/:id/retry", line: 'With the admin token: reads again the sheets that ended in error, or only those named in {"sections": [...]}.' },
  { route: "GET /api/sources", line: "The nine sources and when each was last read." },
  { route: "GET /api/export.json", line: "Curated and watched dossiers, with their events." },
  { route: "GET /api/events", line: "Changes recorded at curated and watched addresses." },
  { route: "GET /api/addresses/:opa/history", line: "Dossiers and events of one account, when it is curated or watched." },
  { route: "GET /api/dossiers/:id/nearby", line: "Events of other watched parcels on the same block." },
  { route: "GET /api/stats", line: "Counts of dossiers, sheets, watches, events and spend." },
  { route: "Refusals", line: 'A refused call answers {"error": "not_found"} (or rate_limited, invalid_input, atlas_unavailable, budget_paused) with the matching HTTP status.' },
];

function limitSentences(): string[] {
  return [
    `A public visitor may draw ${PUBLIC_DOSSIERS_PER_IP_PER_DAY} dossiers per UTC day.`,
    `A public visitor may request ${PUBLIC_UPGRADES_PER_IP_PER_DAY} Agent upgrade per UTC day.`,
    `A public visitor may start ${PUBLIC_WATCHES_PER_IP_PER_DAY} watch per UTC day.`,
    `${PUBLIC_WATCH_SLOTS} public watch slots are open at one time.`,
    `A public watch lasts ${PUBLIC_WATCH_TTL_DAYS} days.`,
    `Groundwork may hold ${MAX_MONITORS} monitors at once.`,
    `${CURATED_ADDRESSES} curated demo addresses stay on the site.`,
    `A dossier younger than ${CACHE_HOURS} hours is returned instead of rebuilt.`,
    `A public dossier and its evidence are kept for ${PUBLIC_DOSSIER_TTL_DAYS} days unless the address is watched.`,
    `A flood probe that found nothing is tried again after ${FLOOD_RETRY_DAYS} days.`,
    `An atlas read that came back incomplete is retried ${FETCH_RETRY_ON_LOADING} times, ${FETCH_RETRY_DELAY_MS / 1000} seconds apart.`,
    `A deep read keeps at most ${DEEP_ROWS_MAX} rows per list.`,
    `Public Agent upgrades pause when spend reaches ${usd(PUBLIC_AGENT_PAUSE_USD)}.`,
    `Every paid TinyFish call pauses when spend reaches ${usd(SPEND_PAUSE_USD)}.`,
    `One Agent run may take ${AGENT_MAX_STEPS} steps and last ${AGENT_MAX_DURATION_SECONDS} seconds.`,
    `One section run is capped at ${usd(AGENT_SECTION_MAX_USD)}.`,
  ];
}

function plateSrc(file: string): string {
  return `/${file.replace(/^public\//, "")}`;
}

export function AboutPage(props: { spend: ToolSpend[]; pageUrl: string; base: string }) {
  return (
    <InnerPage
      heading="ABOUT"
      sentence="What Groundwork reads, what it costs and what it keeps."
      title="About: Groundwork"
      description="What Groundwork reads, what it costs and what it keeps."
      pageUrl={props.pageUrl}
      base={props.base}
    >
      <SheetBlock title="How TinyFish is used">
        <table class="rec">
          <thead>
            <tr>
              <th>Tool</th>
              <th>What it does here</th>
              <th>Calls</th>
              <th>US dollars</th>
            </tr>
          </thead>
          <tbody>
            {props.spend.map((row) => (
              <tr>
                <td data-l="Tool">{row.name}</td>
                <td data-l="What it does here">{row.does}</td>
                <td class="num" data-l="Calls">
                  {int(row.calls)}
                </td>
                <td class="num" data-l="US dollars">
                  {usd(row.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SheetBlock>
      <SheetBlock title="Limits">
        {limitSentences().map((line) => (
          <p>{line}</p>
        ))}
      </SheetBlock>
      <SheetBlock title="What is kept">
        <p>{`A public dossier and its evidence are kept for ${PUBLIC_DOSSIER_TTL_DAYS} days unless the address is watched.`}</p>
        <p>A visitor is counted by a salted hash, never stored as an address.</p>
        <p>One-off lookups appear on no public page.</p>
        <p>A watch a visitor starts is listed for that visitor only.</p>
      </SheetBlock>
      <SheetBlock title="Pictures" id="pictures">
        <p>Nine plates from the Hexamer General Surveys, drawn by Ernest Hexamer between 1866 and 1880. Public domain, via Wikimedia Commons; each plate links to its source page.</p>
        <div class="plates">
          {credits.map((c, i) => (
            <a class="plate" href={c.source}>
              <Frame
                src={plateSrc(c.file)}
                alt={c.title}
                ratio="4/5"
                pos="50% 40%"
                delay={`${(i % 3) * 70}ms`}
                strip={c.title}
                tone={TONES[i % 4]}
                lazy={i > 2}
              />
              <p class="credit">
                {c.series}. {c.creator}. {c.license}, via {c.via}.
              </p>
            </a>
          ))}
        </div>
        <p>The six captures named as city pages as they were read.</p>
        <div class="plates">
          {CAPTURES.map((c, i) => (
            <div class="plate">
              <Frame src={c.src} alt={c.alt} ratio="8/5" pos={c.pos} delay={`${(i % 3) * 70}ms`} strip={c.strip} tone={TONES[i % 4]} lazy />
            </div>
          ))}
        </div>
      </SheetBlock>
      <SheetBlock title="Licence">
        <p>Groundwork is released under the MIT licence. Copyright (c) 2026 Hamdan Esmail.</p>
      </SheetBlock>
      <SheetBlock title="JSON API" id="api">
        <table class="rec">
          <thead>
            <tr>
              <th>Route</th>
              <th>What it returns</th>
            </tr>
          </thead>
          <tbody>
            {API_ROUTES.map((r) => (
              <tr>
                <td class="num" data-l="Route">
                  {r.route}
                </td>
                <td data-l="What it returns">{r.line}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SheetBlock>
    </InnerPage>
  );
}
