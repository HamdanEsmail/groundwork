// Shared pieces of the comps: a framed picture, a status word, facts, a record
// table, a sheet, and evidence. Classes match the comps.
import type { Child } from "hono/jsx";
import type { SectionStatus } from "../sections/types";
import { stamp } from "./format";

export function Arrow() {
  return (
    <svg viewBox="0 0 72 72" fill="none" stroke="currentColor" stroke-width="4" aria-hidden="true">
      <path d="M10 62 60 12M24 12h36v36" />
    </svg>
  );
}

export function Frame(props: {
  src: string;
  alt: string;
  ratio: string;
  pos: string;
  delay: string;
  strip: string;
  tone: "s1" | "s2" | "s3" | "s4";
  lazy?: boolean;
}) {
  return (
    <figure class="frame rise" style={`--d:${props.delay}`}>
      <span class="pic" style={`aspect-ratio:${props.ratio}`}>
        {props.lazy ? (
          <img src={props.src} alt={props.alt} style={`object-position:${props.pos}`} decoding="async" loading="lazy" />
        ) : (
          <img src={props.src} alt={props.alt} style={`object-position:${props.pos}`} decoding="async" />
        )}
      </span>
      <figcaption class={`strip ${props.tone}`}>{props.strip}</figcaption>
    </figure>
  );
}

export function statusWord(status: SectionStatus): { word: string; cls: string } {
  if (status === "ok" || status === "empty") return { word: "Read", cls: "" };
  if (status === "pending") return { word: "Being read", cls: "wait" };
  if (status === "skipped") return { word: "Not read", cls: "wait" };
  return { word: "Could not be read", cls: "gap" };
}

export function StatusWord(props: { status: SectionStatus }) {
  const { word, cls } = statusWord(props.status);
  return <span class={cls ? `state ${cls}` : "state"}>{word}</span>;
}

export function Facts(props: { items: { label: string; value: Child; kind?: "big" | "mono" | "wide" | "" }[] }) {
  return (
    <dl class="facts">
      {props.items.map((it) => (
        <div class={it.kind ?? ""}>
          <dt>{it.label}</dt>
          <dd class={it.kind === "mono" ? "num" : undefined}>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RecordTable(props: {
  heading: string;
  shown: string;
  columns: { name: string; num?: boolean; labelled?: boolean }[];
  rows: Child[][];
  more?: Child;
}) {
  if (props.rows.length === 0) return null;
  return (
    <>
      <h3>
        {props.heading}
        <small>{props.shown}</small>
      </h3>
      <table class="rec">
        <thead>
          <tr>
            {props.columns.map((c) => (
              <th>{c.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((cells) => (
            <tr>
              {cells.map((cell, i) => {
                const col = props.columns[i];
                const cls = col?.num ? "num" : undefined;
                return col?.labelled ? (
                  <td class={cls} data-l={col.name}>
                    {cell}
                  </td>
                ) : (
                  <td class={cls}>{cell}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {props.more}
    </>
  );
}

export function Evidence(props: { url: string | null; label: string; readAt: string | null }) {
  if (!props.url) {
    return <p class="noshot">No screenshot was captured for this sheet. The link above opens the page itself.</p>;
  }
  const when = stamp(props.readAt);
  return (
    <div class="shot">
      <a href={props.url}>
        <img src={props.url} alt={`The ${props.label} page as it was read`} loading="lazy" />
      </a>
      <p>The page as it was read on {when}. Open it at full size.</p>
    </div>
  );
}

/**
 * The address form's button, and the note that says how long its answer takes. Reading the four city
 * pages happens before the form answers, so the script shows the note and starts its clock the moment
 * the button is pressed. Without the script the note stays hidden and the browser shows its own loading.
 */
export function AskButton() {
  return (
    <>
      <button class="btn" type="submit" data-busy="Reading…">
        Draw the dossier
      </button>
      <p class="wait-note" data-wait hidden>
        <span class="clock num" data-since="">
          0:00
        </span>{" "}
        so far. Reading the four city pages takes about 40 seconds.
      </p>
    </>
  );
}

export function shownLabel(shown: number, count: number | null): string {
  if (count == null) return shown === 1 ? "1 shown" : `${intLike(shown)} shown`;
  if (shown < count) return `${intLike(shown)} of ${intLike(count)} shown`;
  return count === 1 ? "1 on file" : `${intLike(count)} on file`;
}

function intLike(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}
