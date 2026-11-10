// The home, section by section as the comp. Frames, board, run-in and close
// are static. The nine sources, the events and the four figures are live.
import { SECTIONS } from "../sections/index";
import type { SectionId } from "../sections/types";
import { Arrow, Frame, AskButton } from "./components";
import { int, usd } from "./format";
import { Layout } from "./layout";

const HOLDS: Record<SectionId, string> = {
  property: "Owner, building, assessed value, last sale",
  zoning: "Zoning district, overlays, pending bills, appeals",
  licenses_inspections: "Recent permits, inspections, violations, appeals, licences",
  deeds: "Parcel, area, recorded deed documents",
  assessment_history: "Assessed value, year by year",
  tax: "Real estate tax balance",
  flood: "Flood zone",
  schools: "Catchment schools",
  li_deep: "Every permit and violation on file",
};

export const DEMO_ADDRESSES = ["1234 Market St", "5600 Germantown Ave", "4001 Walnut St"] as const;

export interface HomeEvent {
  at: string | null;
  address: string;
  summary: string;
  sheet: string;
}

export interface HomeProps {
  note: string | null;
  demos: { label: string; href: string }[];
  events: HomeEvent[];
  stats: { dossiers: number; sheets: number; gaps: number; spend: number };
  pageUrl: string;
  base: string;
}

export function Home(props: HomeProps) {
  return (
    <Layout title="Groundwork: what Philadelphia holds on one address" description="Type a Philadelphia address. Groundwork reads nine official city sources and returns one dossier, every record linked to the page it came from." pageUrl={props.pageUrl} base={props.base}>
      <main>
        <Sheet demos={props.demos} note={props.note} />
        <Board />
        <RunIn />
        <Offices />
        <Changed events={props.events} />
        <Measured stats={props.stats} />
        <Close />
      </main>
    </Layout>
  );
}

function Sheet(props: { demos: HomeProps["demos"]; note: string | null }) {
  return (
    <div class="sheet" id="top">
      <div class="col">
        <Frame src="/assets/plates/baldwin.jpg" alt="Hand-coloured plan of the blacksmith shops of the Baldwin Locomotive Works" ratio="4/5" pos="20% 22%" delay="70ms" strip="Baldwin Locomotive Works, 1866" tone="s1" />
        <Frame src="/assets/captures/market-licences.jpg" alt="The city's licences and inspections page for 1234 Market St as it was read" ratio="8/5" pos="0 0" delay="140ms" strip="Licences, 1234 Market St" tone="s3" />
        <Frame src="/assets/plates/paper.jpg" alt="Survey plate of a paper mill on the Wissahickon" ratio="1/1" pos="50% 30%" delay="210ms" strip="Wissahickon Paper Mills, 1866" tone="s2" />
        <Frame src="/assets/plates/woolen.jpg" alt="Detail of a woolen mill survey with its written description" ratio="4/5" pos="50% 70%" delay="280ms" strip="Shaw's Woolen Mills, 1866" tone="s4" lazy />
      </div>
      <div class="col">
        <Frame src="/assets/plates/hosiery.jpg" alt="Plan of the Germantown Hosiery Mills with each building numbered" ratio="1/1" pos="30% 40%" delay="350ms" strip="Germantown Hosiery Mills, 1866" tone="s1" />
        <Frame src="/assets/plates/midvale.jpg" alt="Bird's-eye drawing of the Midvale Steel Works" ratio="4/5" pos="78% 88%" delay="0ms" strip="Midvale Steel Works, 1879" tone="s3" />
        <Frame src="/assets/captures/germantown-assessment.jpg" alt="The city's assessment page for 5600 Germantown Ave as it was read" ratio="8/5" pos="0 0" delay="70ms" strip="Assessment, 5600 Germantown" tone="s2" />
        <Frame src="/assets/plates/glen-echo.jpg" alt="Detail of the Glen Echo Mills survey" ratio="4/5" pos="40% 60%" delay="140ms" strip="Glen Echo Mills, 1866" tone="s4" lazy />
      </div>
      <div class="mid">
        <div class="pair top">
          <div class="col">
            <Frame src="/assets/plates/shot-tower.jpg" alt="Elevation of the Sparks Shot Tower from an 1880 survey" ratio="5/4" pos="30% 50%" delay="210ms" strip="Sparks Shot Tower, 1880" tone="s1" />
          </div>
          <div class="col">
            <Frame src="/assets/plates/carriage.jpg" alt="Title of a survey plate for a carriage works" ratio="5/4" pos="50% 20%" delay="280ms" strip="Carriage works, 1866" tone="s3" />
          </div>
        </div>
        <div class="cell">
          <p class="mark">Groundwork</p>
          <h1>What nine public records hold on one Philadelphia address, each linked to its source.</h1>
          <form class="ask" action="/go" method="post">
            {props.note ? <p class="flash">{props.note}</p> : null}
            <label for="address">Address or OPA account</label>
            <input id="address" name="address" placeholder="1234 Market St" autocomplete="off" required maxlength={200} />
            <AskButton />
          </form>
          <p class="tries">
            Try{" "}
            {props.demos.map((d) => (
              <a href={d.href}>{d.label}</a>
            ))}
          </p>
          <nav aria-label="Pages">
            <a href="#sources">Sources</a>
            <a href="/watchlist">Watchlist</a>
            <a href="/about#api">JSON API</a>
          </nav>
        </div>
        <div class="pair">
          <div class="col">
            <Frame src="/assets/captures/walnut-zoning.jpg" alt="The city's zoning page for 4001 Walnut St as it was read" ratio="8/5" pos="0 0" delay="350ms" strip="Zoning, 4001 Walnut St" tone="s2" />
            <Frame src="/assets/plates/perseverance.jpg" alt="Plan of the Perseverance Mills" ratio="1/1" pos="50% 45%" delay="0ms" strip="Perseverance Mills, 1866" tone="s4" lazy />
          </div>
          <div class="col">
            <Frame src="/assets/plates/midvale.jpg" alt="Plan of the Midvale Steel Works foundry and hammer shop" ratio="1/1" pos="30% 55%" delay="70ms" strip="Midvale Steel Works, 1879" tone="s1" />
            <Frame src="/assets/captures/market-deeds.jpg" alt="The city's deeds page for 1234 Market St as it was read" ratio="8/5" pos="0 0" delay="140ms" strip="Deeds, 1234 Market St" tone="s3" lazy />
          </div>
        </div>
      </div>
      <div class="col">
        <Frame src="/assets/plates/glen-echo.jpg" alt="Title and plan of the Glen Echo Mills survey" ratio="4/5" pos="55% 18%" delay="210ms" strip="Glen Echo Mills, 1866" tone="s2" />
        <Frame src="/assets/captures/germantown-zoning.jpg" alt="The city's zoning page for 5600 Germantown Ave as it was read" ratio="8/5" pos="0 0" delay="280ms" strip="Zoning, 5600 Germantown" tone="s4" />
        <Frame src="/assets/plates/carriage.jpg" alt="Plan of a carriage works, each floor described" ratio="1/1" pos="45% 62%" delay="350ms" strip="Carriage works, 1866" tone="s1" />
        <Frame src="/assets/plates/baldwin.jpg" alt="The erecting shop on the Baldwin Locomotive Works plan" ratio="4/5" pos="70% 80%" delay="0ms" strip="Baldwin Locomotive Works, 1866" tone="s3" lazy />
      </div>
      <div class="col">
        <Frame src="/assets/plates/midvale.jpg" alt="The written description on the Midvale Steel Works plate: owner, walls, roof, boilers" ratio="1/1" pos="88% 30%" delay="70ms" strip="Midvale Steel Works, 1879" tone="s2" />
        <Frame src="/assets/plates/perseverance.jpg" alt="Lower half of the Perseverance Mills plate" ratio="4/5" pos="50% 80%" delay="140ms" strip="Perseverance Mills, 1866" tone="s4" />
        <Frame src="/assets/captures/walnut-assessment.jpg" alt="The city's assessment page for 4001 Walnut St as it was read" ratio="8/5" pos="0 0" delay="210ms" strip="Assessment, 4001 Walnut St" tone="s1" />
        <Frame src="/assets/plates/hosiery.jpg" alt="Detail of the Germantown Hosiery Mills plate" ratio="4/5" pos="70% 75%" delay="280ms" strip="Germantown Hosiery Mills, 1866" tone="s3" lazy />
      </div>
    </div>
  );
}

function Board() {
  return (
    <section aria-labelledby="plate">
      <div class="board shutter">
        <picture class="drift">
          <source media="(max-width:820px)" srcset="/assets/plates/baldwin.jpg" />
          <img src="/assets/plates/midvale.jpg" alt="Ernest Hexamer's 1879 survey of the Midvale Steel Works: a coloured plan, a bird's-eye view and a written description of the property" loading="lazy" decoding="async" />
        </picture>
        <div class="tile say h blue t1">
          <h2 id="plate">Drawn in 1879</h2>
          <small>Midvale Steel Works, Nicetown. Surveyed for fire insurers, one plate per property.</small>
        </div>
        <div class="tile say inkt t2">
          <small>Walls</small>
          <p>Brick, mostly 21 inches thick.</p>
        </div>
        <div class="tile say pale t3">
          <small>Boilers</small>
          <p>18 on the premises.</p>
        </div>
        <div class="tile say wash t4">
          <small>Watchman</small>
          <p>Night and Sunday, constantly.</p>
        </div>
        <a class="tile say go t5" href="#top">
          <p>Today's is read from the city's own pages. Open one.</p>
          <Arrow />
        </a>
      </div>
    </section>
  );
}

function RunIn() {
  return (
    <section class="wrap" aria-labelledby="how">
      <div class="run">
        <h2 id="how" class="rise">
          How a dossier is drawn
        </h2>
        <p class="rise">
          <b>To begin,</b> type the address the way you would say it. A trailing full stop, a ZIP code or lower case all land on the same parcel, and a condominium building answers with its units. An address the city does not hold is reported as no match, never guessed.
        </p>
        <div class="ev ui rise" data-ui>
          <div class="row">
            <span class="k">You typed</span>
            <span class="v">1234 Market St Philadelphia PA 19107</span>
          </div>
          <div class="row">
            <span class="k">The city holds</span>
            <span class="v">1234 MARKET ST, PHILADELPHIA, PA 19107-3721</span>
          </div>
          <div class="row">
            <span class="k">OPA account</span>
            <span class="v">883309050</span>
          </div>
        </div>
        <p class="rise">
          <b>Within a minute,</b> TinyFish Fetch reads four pages of the city atlas: assessment and sale, zoning, licences and inspections, deeds. A page that is still loading is read again. One that will not load becomes a marked gap with the link to check by hand.
        </p>
        <div class="ev three rise">
          <img src="/assets/captures/market-licences.jpg" alt="The licences and inspections page as read" loading="lazy" />
          <img src="/assets/captures/germantown-assessment.jpg" alt="An assessment page as read" loading="lazy" />
          <img src="/assets/captures/walnut-zoning.jpg" alt="A zoning page as read" loading="lazy" />
        </div>
        <p class="rise">
          <b>On request,</b> TinyFish Agent opens the five sources that have no simple page: assessment history, the tax balance, the flood map, catchment schools and the full permit history. Each read is capped, and its price is shown before it starts.
        </p>
        <div class="ev ui rise" data-ui>
          <div class="row">
            <span>Real estate tax, Department of Revenue</span>
            <span class="v">up to $0.224</span>
          </div>
          <div class="row">
            <span>Flood zone, FEMA</span>
            <span class="v">up to $0.224</span>
          </div>
          <div class="row">
            <span>Catchment schools, School District</span>
            <span class="v">up to $0.224</span>
          </div>
        </div>
        <p class="rise">
          <b>From then on,</b> TinyFish Monitor checks the licences page and the assessment page of a watched address twice a day. A new permit, a new violation, a sale or a changed assessment is recorded with what the page said before and after.
        </p>
        <div class="ev ui rise" data-ui>
          <div class="row">
            <span class="k">An alert reads like this</span>
            <span class="k">example</span>
          </div>
          <div class="row">
            <span>New permit at 1234 Market St</span>
            <span class="v">155 to 156 permits</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function Offices() {
  return (
    <section class="wrap nine" id="sources" aria-labelledby="nine">
      <h2 id="nine" class="rise">
        Nine sources,<span>one sheet each</span>
      </h2>
      <table class="rise">
        <thead>
          <tr>
            <th>Office</th>
            <th>What it holds</th>
            <th>Read by</th>
            <th>Monitor</th>
          </tr>
        </thead>
        <tbody>
          {SECTIONS.map((s) => (
            <tr>
              <td>{s.agency}</td>
              <td>{HOLDS[s.id]}</td>
              <td>{s.method === "fetch" ? "Fetch" : "Agent"}</td>
              <td>{s.monitorable ? "Watched" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Changed(props: { events: HomeEvent[] }) {
  return (
    <section class="wrap nine changed" id="changed" aria-labelledby="changed-h">
      <h2 id="changed-h" class="rise">
        What changed<span>at watched addresses</span>
      </h2>
      {props.events.length === 0 ? (
        <p class="empty rise">No change has been recorded yet. Monitor reads each watched page twice a day.</p>
      ) : (
        <table class="rise">
          <thead>
            <tr>
              <th>Date</th>
              <th>Address</th>
              <th>What changed</th>
              <th>The sheet</th>
            </tr>
          </thead>
          <tbody>
            {props.events.map((e) => (
              <tr>
                <td>{e.at}</td>
                <td>{e.address}</td>
                <td>{e.summary}</td>
                <td>{e.sheet}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Measured(props: { stats: HomeProps["stats"] }) {
  return (
    <section class="wrap" aria-labelledby="measured">
      <div class="quiet">
        <h2 id="measured" class="rise">
          On the ledger so far
        </h2>
        <dl>
          <div class="rise">
            <dt>{int(props.stats.dossiers)}</dt>
            <dd>dossiers built.</dd>
          </div>
          <div class="rise">
            <dt>{int(props.stats.sheets)}</dt>
            <dd>sheets read from official pages.</dd>
          </div>
          <div class="rise">
            <dt>{int(props.stats.gaps)}</dt>
            <dd>gaps marked, where a page could not be read.</dd>
          </div>
          <div class="rise">
            <dt>{usd(props.stats.spend)}</dt>
            <dd>spent on TinyFish calls.</dd>
          </div>
        </dl>
      </div>
      <div class="quiet-pic rise">
        <img src="/assets/plates/shot-tower.jpg" alt="The Sparks Shot Tower in an 1880 survey" style="object-position:28% 50%" loading="lazy" />
      </div>
    </section>
  );
}

function Close() {
  return (
    <section class="close" aria-label="Start">
      <div class="trio">
        <span>
          <img src="/assets/plates/hosiery.jpg" alt="Plan of the Germantown Hosiery Mills, 1866" style="object-position:40% 45%" loading="lazy" />
        </span>
        <span>
          <img src="/assets/plates/glen-echo.jpg" alt="Plan of the Glen Echo Mills, 1866" style="object-position:50% 50%" loading="lazy" />
        </span>
        <span>
          <img src="/assets/plates/carriage.jpg" alt="Plan of a carriage works, 1866" style="object-position:50% 60%" loading="lazy" />
        </span>
      </div>
      <div class="band">
        <p class="big rise">
          Before you buy, build or renovate, <a href="#top">read what the city holds</a> on the address.
        </p>
        <p class="note rise">Groundwork reports what the official pages say and marks what it could not read. It gives no valuation and no advice.</p>
      </div>
    </section>
  );
}
