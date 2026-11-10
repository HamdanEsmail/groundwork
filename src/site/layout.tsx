// The document every screen shares: title, description, fonts, stylesheets, the three scripts
// (all files of this site: the content security policy allows no inline script), the top bar of
// inner screens, and the footer of tiles with the Philadelphia clock. Every screen reads the same
// without the scripts.
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { Arrow } from "./components";

const FONTS =
  "https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap";

function canonicalOf(base: string, pageUrl: string): string {
  const root = base.replace(/\/$/, "");
  try {
    return `${root}${new URL(pageUrl).pathname}`;
  } catch {
    return root;
  }
}

export function Layout(props: {
  title: string;
  description: string;
  dossier?: boolean;
  inner?: boolean;
  bar?: boolean;
  refreshSeconds?: number;
  pageUrl: string;
  base: string;
  children: Child;
}) {
  const root = props.base.replace(/\/$/, "");
  const canonical = canonicalOf(props.base, props.pageUrl);
  const image = `${root}/assets/social.jpg`;
  const dossierCss = Boolean(props.dossier || props.inner);
  const bar = Boolean(props.bar || props.inner || props.dossier);
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          {props.refreshSeconds !== undefined ? <meta http-equiv="refresh" content={String(props.refreshSeconds)} /> : null}
          <title>{props.title}</title>
          <meta name="description" content={props.description} />
          <meta name="author" content="Hamdan Esmail" />
          <link rel="canonical" href={canonical} />
          <meta property="og:title" content={props.title} />
          <meta property="og:description" content={props.description} />
          <meta property="og:image" content={image} />
          <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
          <link href={FONTS} rel="stylesheet" />
          <link rel="stylesheet" href="/assets/site.css" />
          {dossierCss ? <link rel="stylesheet" href="/assets/dossier.css" /> : null}
          <script src="/assets/js-on.js"></script>
          <script src="/assets/site.js" defer></script>
          <script src="/assets/wait.js" defer></script>
        </head>
        <body>
          {bar ? <Bar /> : null}
          {props.children}
          {props.dossier ? <DossierFooter /> : <SiteFooter home={!props.inner} />}
        </body>
      </html>
    </>
  );
}

/** Who built it, linked to his GitHub: in the footer of every page. */
function Credit() {
  return (
    <>
      Built by{" "}
      <a href="https://github.com/HamdanEsmail" rel="author">
        Hamdan Esmail
      </a>
    </>
  );
}

function Bar() {
  return (
    <div class="bar">
      <a class="mark" href="/">
        Groundwork
      </a>
      <nav aria-label="Pages">
        <a href="/">New dossier</a>
        <a href="/watchlist">Watchlist</a>
        <a href="/sources">Sources</a>
      </nav>
    </div>
  );
}

function SiteFooter(props: { home: boolean }) {
  const start = props.home ? "#top" : "/";
  return (
    <footer>
      <div class="ft a">
        <p>Every record carries its source link and the time it was read.</p>
        <small>
          Not affiliated with the City of Philadelphia. MIT licence. <Credit /> for the TinyFish bounty.
        </small>
      </div>
      <div class="ft b">
        <ul>
          <li>
            <a href={start}>New dossier</a>
          </li>
          <li>
            <a href="/sources">Sources</a>
          </li>
          <li>
            <a href="/watchlist">Watchlist</a>
          </li>
          <li>
            <a href="/about#api">JSON API</a>
          </li>
        </ul>
      </div>
      <div class="ft c">
        <span>Philadelphia</span>
        <span class="num" id="clock">
          Eastern time
        </span>
      </div>
      <div class="ft d">
        <small>Pictures: Hexamer General Surveys of Philadelphia, 1866 to 1880, by Ernest Hexamer. Public domain, via Wikimedia Commons. Screenshots: phila.gov pages as read.</small>
        <a href="/about#pictures">All credits</a>
      </div>
      <div class="ft w">
        <span>Groundwork</span>
      </div>
      <a class="ft g" href={start}>
        <b>Draw a dossier</b>
        <Arrow />
      </a>
    </footer>
  );
}

function DossierFooter() {
  return (
    <footer>
      <div class="ft a">
        <p>Every record carries its source link and the time it was read.</p>
        <small>
          A report of what the official pages say, not a valuation and not advice. Not affiliated with the City of Philadelphia. <Credit />.
        </small>
      </div>
      <div class="ft b">
        <ul>
          <li>
            <a href="/">New dossier</a>
          </li>
          <li>
            <a href="/sources">Sources</a>
          </li>
          <li>
            <a href="/watchlist">Watchlist</a>
          </li>
          <li>
            <a href="#json">This dossier as JSON</a>
          </li>
        </ul>
      </div>
      <div class="ft c">
        <span>Philadelphia</span>
        <span class="num" id="clock">
          Eastern time
        </span>
      </div>
      <div class="ft d">
        <small>Read with TinyFish Fetch from atlas.phila.gov. Screenshots show the pages as they were read.</small>
        <a href="#" data-print>
          Print this dossier
        </a>
      </div>
      <div class="ft w">
        <span>Groundwork</span>
      </div>
      <a class="ft g" href="/">
        <b>Draw another dossier</b>
        <Arrow />
      </a>
    </footer>
  );
}

