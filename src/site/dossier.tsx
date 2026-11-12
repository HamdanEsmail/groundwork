// The dossier screen of the comp, in every condition the plan names.
import type { Units } from "../address/resolve";
import type { DossierDocument } from "../dossier/document";
import { normalizeAddress } from "../address/normalize";
import { SECTIONS } from "../sections/index";
import type { SectionId, SectionStatus } from "../sections/types";
import type { ResolutionDetail } from "../db/types";
import { AskButton, statusWord } from "./components";
import { cost, day, stamp, usd, waitClock } from "./format";
import { Layout } from "./layout";
import { RestSheet, SheetArticle } from "./sheets";
import { buildTimeline, figures, splitAddress } from "./timeline";

export interface DossierPageProps {
  doc: DossierDocument;
  /** When the sheets still being read were started; null when nothing is being read. */
  workStartedAt?: string | null;
  flag: string | null;
  units: Units | null;
  detail: ResolutionDetail | null;
  unresolved: boolean;
  pageUrl: string;
  base: string;
}

export function DossierPage(props: DossierPageProps) {
  if (props.unresolved) return <FailedDossier doc={props.doc} detail={props.detail} pageUrl={props.pageUrl} base={props.base} />;
  return <ResolvedDossier doc={props.doc} flag={props.flag} units={props.units} workStartedAt={props.workStartedAt ?? null} pageUrl={props.pageUrl} base={props.base} />;
}

function FailedDossier(props: { doc: DossierDocument; detail: ResolutionDetail | null; pageUrl: string; base: string }) {
  const typed = props.doc.address.input;
  const detail = props.detail ?? (props.doc.resolution_detail as ResolutionDetail | undefined) ?? {};
  const title = typed || "No match";
  return (
    <Layout
      title={`${title}: Groundwork dossier`}
      description={`What Philadelphia's official sources hold on ${title}, each record linked to the page it came from.`}
      dossier
      bar
      pageUrl={props.pageUrl}
      base={props.base}
      jsonHref={`/api/dossiers/${props.doc.dossier_id}`}
    >
      <main>
        <div class="title">
          <h1>{title}</h1>
          <p class="city">Philadelphia</p>
          {detail.how_to_resolve ? <p class="flag">{detail.how_to_resolve}</p> : null}
          <form class="ask" action="/go" method="post">
            <label for="address">Address or OPA account</label>
            <input id="address" name="address" placeholder="1234 Market St" autocomplete="off" required maxlength={200} />
            <AskButton />
          </form>
        </div>
        <div class="set">
          <div class="sheets">
            <article class="sh rise">
              <header>
                <p class="no">Resolution</p>
                <h2>What was tried</h2>
              </header>
              {detail.variants_tried?.length ? (
                <p>Tried {detail.variants_tried.join(", ")}.</p>
              ) : null}
              {detail.how_to_resolve ? <p>{detail.how_to_resolve}</p> : null}
              {detail.candidates?.length ? (
                <ul>
                  {detail.candidates.map((c) => (
                    <li>
                      <form action="/go" method="post">
                        <input type="hidden" name="address" value={c.address} />
                        <button class="btn quiet" type="submit">
                          {c.address}
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              ) : null}
              {detail.manual_url ? (
                <p>
                  <a href={detail.manual_url}>Open the city atlas</a>
                </p>
              ) : null}
            </article>
          </div>
        </div>
      </main>
    </Layout>
  );
}

function ResolvedDossier(props: { doc: DossierDocument; flag: string | null; units: Units | null; workStartedAt: string | null; pageUrl: string; base: string }) {
  const doc = props.doc;
  const { title, city } = splitAddress(doc.address.resolved, doc.address.input);
  const ctx = { address: title, opa: doc.address.opa_account ?? "" };
  const readAt = doc.completed_at ?? doc.created_at;
  const count = (status: SectionStatus) => SECTIONS.filter((s) => doc.sections[s.id as keyof typeof doc.sections]?.status === status).length;
  // A sheet whose source was searched and held nothing is not a sheet that was read.
  const sheetsRead = count("ok");
  const foundNothing = count("empty");
  // On a condominium unit's report the licences and deeds sheets are the address's, not only the unit's.
  const isUnit = normalizeAddress(title).unit !== null;
  const figs = figures(doc);
  const tl = buildTimeline(doc);
  const skipped = SECTIONS.map((s, i) => ({ n: i + 1, id: s.id, sec: doc.sections[s.id as keyof typeof doc.sections] })).filter(
    (x) => x.sec?.status === "skipped",
  );
  const shown = SECTIONS.map((s, i) => ({ n: i + 1, id: s.id, sec: doc.sections[s.id as keyof typeof doc.sections] })).filter(
    (x) => x.sec && x.sec.status !== "skipped",
  );
  const canUpgrade = doc.tier === "free" && skipped.some((s) => s.id !== "li_deep");
  const jsonHref = doc.json_url.replace(/^https?:\/\/[^/]+/, "") || `/api/dossiers/${doc.dossier_id}`;
  const parent = doc.address.resolution === "parent" ? props.units : null;
  const fuzzy = doc.address.resolution === "fuzzy";
  const partial = doc.status === "partial";
  // While sheets are still being read: how many of those asked for are done (read, or given up on), and
  // how long the reading has gone on.
  const done = shown.filter((x) => x.sec?.status !== "pending").length;
  const clock = waitClock(props.workStartedAt, new Date());
  return (
    <Layout
      title={`${title}: Groundwork dossier`}
      description={`What Philadelphia's official sources hold on ${title}, each record linked to the page it came from.`}
      dossier
      bar
      refreshSeconds={partial ? 10 : undefined}
      pageUrl={props.pageUrl}
      base={props.base}
    >
      <main>
        <div class="title">
          <h1>{title}</h1>
          <p class="city">{city}</p>
          <div class="acts">
            {canUpgrade ? (
              <a class="btn" href="#rest">
                Read four more sheets
              </a>
            ) : null}
            <form method="post" action={`/d/${doc.dossier_id}/watch`}>
              <button class="btn quiet" type="submit" data-busy="Starting the watch…">
                Watch this address
              </button>
            </form>
            <a class="btn quiet" id="json" href={jsonHref}>
              JSON
            </a>
          </div>
          {partial ? (
            <div class="working" role="status">
              <progress class="meter" value={done} max={shown.length}>
                {done} of {shown.length}
              </progress>
              <p>
                {done} of {shown.length} sheets done.{" "}
                {clock !== null ? (
                  <>
                    <span class="clock num" data-since={props.workStartedAt ?? ""}>
                      {clock}
                    </span>{" "}
                    so far.{" "}
                  </>
                ) : null}
                Each of the sheets still to read takes up to 3 minutes. This page refreshes itself.
              </p>
            </div>
          ) : null}
          <dl class="block">
            <div>
              <dt>OPA account</dt>
              <dd>{doc.address.opa_account ?? "not stated"}</dd>
            </div>
            <div>
              <dt>Read</dt>
              <dd>{stamp(readAt)}</dd>
            </div>
            <div>
              <dt>Sheets read</dt>
              <dd>
                {sheetsRead} of 9{foundNothing ? `, ${foundNothing} searched and found nothing` : ""}
              </dd>
            </div>
            <div>
              <dt>Cost of this dossier</dt>
              <dd>{cost(doc.spend_usd)}</dd>
            </div>
          </dl>
          {fuzzy ? (
            <p class="flag">
              You typed {doc.address.input}. The city holds {doc.address.resolved}.
            </p>
          ) : null}
          {parent ? (
            <>
              <p class="flag">
                This is the record of the whole building.{" "}
                {parent.kind === "active_parcels"
                  ? `The city counts ${parent.count} active parcels at this address.`
                  : `The city's atlas lists ${parent.count} condominium unit${parent.count === 1 ? "" : "s"} at this address.`}
              </p>
              {parent.list?.length ? (
                <ul class="units">
                  {parent.list.map((u) => (
                    <li>
                      <form action="/go" method="post">
                        <input type="hidden" name="address" value={u.opa_account} />
                        <button class="btn quiet" type="submit">
                          {u.address}
                          {u.opa_account === doc.address.opa_account ? " (this record)" : ""}
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              ) : parent.list_url ? (
                <p class="flag">
                  <a href={parent.list_url}>Open the city's list of units</a>
                </p>
              ) : null}
            </>
          ) : null}
          {doc.cached ? <p class="flag">This is a copy of a report read earlier. A report is reused for 24 hours.</p> : null}
          {props.flag ? <p class="flag">{props.flag}</p> : null}
        </div>
        {figs.length ? (
          <div class="figs">
            {figs.map((f, i) => (
              <div class={`rise${f.alert ? " alert" : ""}`} style={i ? `--d:${i * 70}ms` : undefined}>
                <b>{f.value}</b>
                <span>{f.line}</span>
              </div>
            ))}
          </div>
        ) : null}
        {tl ? (
          <section class="dates" aria-labelledby="dates">
            <h2 id="dates" class="rise">
              The record, by date
            </h2>
            <p class="rise">Every dated record in the sheets read so far, {tl.fromBuilt ? "from the year the building went up" : "from the oldest dated record"}. The free sheets show the latest five of each kind. Point at a mark to read it.</p>
            <div class="lanes">
              {tl.lanes.map((lane) => (
                <div class="lane rise">
                  <p class="name">
                    {lane.name}
                    <small>{lane.note}</small>
                  </p>
                  <div class="track">
                    {lane.ticks.map((t) => (
                      <button class={t.hot ? "tick hot" : "tick"} style={`left:${t.left}`} data-say={t.say} aria-label={t.say} type="button" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div class="years" aria-hidden="true">
              {tl.years.map((y) => (
                <span style={`left:${y.left}`}>{y.label}</span>
              ))}
            </div>
            <p class="readout" id="readout" aria-live="polite">
              {tl.readout}
            </p>
          </section>
        ) : null}
        <div class="set">
          <nav class="index" aria-label="Sheets">
            {SECTIONS.map((s, i) => {
              const sec = doc.sections[s.id as keyof typeof doc.sections];
              const st = (sec?.status ?? "skipped") as SectionStatus;
              const { word } = statusWord(st);
              const href = st === "skipped" ? "#rest" : `#${s.id}`;
              return (
                <a href={href} class={i === 0 ? "now" : undefined}>
                  <span>
                    {i + 1}. {s.label}
                  </span>
                  <small>{word}</small>
                </a>
              );
            })}
          </nav>
          <div class="sheets">
            {shown.map(({ n, id, sec }) => (
              <SheetArticle n={n} id={id} sec={sec} ctx={ctx} unit={isUnit} />
            ))}
            <RestSheet skipped={skipped.map((s) => ({ id: s.id, sec: s.sec }))} ctx={ctx} canUpgrade={canUpgrade} dossierId={doc.dossier_id} />
          </div>
        </div>
      </main>
    </Layout>
  );
}
