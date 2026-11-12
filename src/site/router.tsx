// Page routes. Form posts call the same functions as the JSON API, with the
// same limits. A note in the query is chosen from a fixed list, never echoed.
import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { isAdmin, visitorHash } from "../auth";
import { totalSpend } from "../core/spend";
import { getDossier } from "../db/dossiers";
import { listWatches } from "../db/watches";
import { getSections } from "../db/sections";
import { createDossier, DossierError } from "../dossier/build";
import { toDossierDocument } from "../dossier/document";
import { upgradeDossier } from "../dossier/upgrade";
import { watchDossier } from "../dossier/watch";
import type { Env } from "../env";
import { AboutPage } from "./about";
import { DossierPage } from "./dossier";
import { day } from "./format";
import { DEMO_ADDRESSES, Home } from "./home";
import { NotFoundPage } from "./inner";
import { dossierNoteCode, DOSSIER_NOTES, homeNote } from "./notes";
import { lastSuccessBySection, publicEvents, toolSpend, watchlistData } from "./query";
import { SourcesPage } from "./sources";
import { WatchlistPage } from "./watchlist";

type AppContext = Context<{ Bindings: Env }>;

const siteRouter = new Hono<{ Bindings: Env }>();

/** Where pictures may come from: this site, and the address its evidence links carry (the same site in production). */
function imageSources(base: string): string {
  try {
    return `'self' data: ${new URL(base).origin}`;
  } catch {
    return "'self' data:";
  }
}

/**
 * Every screen is sent with a content security policy: files of this site only, the two font hosts, no
 * inline script, no framing, forms that post here. City text and what a visitor types are escaped as
 * well; this is the second lock.
 */
function render(c: AppContext, page: Child, status: ContentfulStatusCode = 200, headers: Record<string, string> = {}) {
  return c.html(page as unknown as string, status, {
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "style-src-attr 'unsafe-inline'",
      "font-src https://fonts.gstatic.com",
      `img-src ${imageSources(c.env.PUBLIC_BASE_URL)}`,
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    ...headers,
  });
}

async function demoLinks(db: D1Database): Promise<{ label: string; href: string }[]> {
  const out: { label: string; href: string }[] = [];
  for (const label of DEMO_ADDRESSES) {
    const streetName = label.toUpperCase();
    const row = await db
      .prepare(
        `SELECT id FROM dossiers
         WHERE added_by = 'curated' AND (
           UPPER(COALESCE(address_input, '')) = UPPER(?)
           OR UPPER(COALESCE(address_resolved, '')) LIKE ? || '%'
         )
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .bind(label, streetName)
      .first<{ id: string }>();
    out.push({ label, href: row ? `/d/${row.id}` : "#top" });
  }
  return out;
}

async function homeStats(db: D1Database): Promise<{ dossiers: number; sheets: number; gaps: number; spend: number }> {
  const dossiers = (await db.prepare("SELECT COUNT(*) AS n FROM dossiers").first<{ n: number }>())?.n ?? 0;
  const sheets = (await db.prepare("SELECT COUNT(*) AS n FROM sections WHERE status = 'ok'").first<{ n: number }>())?.n ?? 0;
  const gaps =
    (await db.prepare("SELECT COUNT(*) AS n FROM sections WHERE status IN ('unavailable', 'error')").first<{ n: number }>())?.n ?? 0;
  return { dossiers, sheets, gaps, spend: await totalSpend(db) };
}

function pageMeta(c: AppContext): { pageUrl: string; base: string } {
  return { pageUrl: c.req.url, base: c.env.PUBLIC_BASE_URL };
}

export function siteNotFound(c: AppContext) {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "not_found" }, 404);
  return render(c, <NotFoundPage {...pageMeta(c)} />, 404);
}

siteRouter.get("/", async (c) => {
  const note = homeNote(c.req.query("note"));
  const [demos, events, stats] = await Promise.all([demoLinks(c.env.DB), publicEvents(c.env.DB, 10), homeStats(c.env.DB)]);
  return render(c, <Home note={note} demos={demos} events={events} stats={stats} {...pageMeta(c)} />);
});

siteRouter.get("/watchlist", async (c) => {
  const data = await watchlistData(c.env.DB, await visitorHash(c.env, c.req.header("CF-Connecting-IP")));
  return render(c, <WatchlistPage data={data} {...pageMeta(c)} />);
});

siteRouter.get("/sources", async (c) => {
  const lastSuccess = await lastSuccessBySection(c.env.DB);
  return render(c, <SourcesPage lastSuccess={lastSuccess} {...pageMeta(c)} />);
});

siteRouter.get("/about", async (c) => {
  const spend = await toolSpend(c.env.DB);
  return render(c, <AboutPage spend={spend} {...pageMeta(c)} />);
});

siteRouter.post("/go", async (c) => {
  const body = await c.req.parseBody();
  const raw = typeof body.address === "string" ? body.address : "";
  const value = raw.trim();
  if (value === "" || value.length > 200) return c.redirect("/?note=unusable#top", 303);
  const input = /^\d{9}$/.test(value) ? { opa_account: value } : { address: value };
  try {
    // A visitor who closes the page while the city is being read must not leave a dossier half read:
    // work handed to waitUntil is allowed to finish after the client has gone.
    const work = createDossier(c.env, input, {
      admin: false,
      ipHash: await visitorHash(c.env, c.req.header("CF-Connecting-IP")),
    });
    c.executionCtx.waitUntil(work.catch(() => undefined));
    const result = await work;
    return c.redirect(`/d/${result.dossierId}`, 303);
  } catch (err) {
    if (err instanceof DossierError) {
      if (err.status === 429) return c.redirect("/?note=limit#top", 303);
      if (err.status === 502) return c.redirect("/?note=atlas#top", 303);
    }
    throw err;
  }
});

siteRouter.get("/d/:id", async (c) => {
  const dossier = await getDossier(c.env.DB, c.req.param("id"));
  if (!dossier) return render(c, <NotFoundPage {...pageMeta(c)} />, 404);
  const rows = await getSections(c.env.DB, dossier.id);
  const watches = dossier.opa_account ? await listWatches(c.env.DB, { opa: dossier.opa_account, status: "active" }) : [];
  const doc = toDossierDocument(dossier, rows, c.env.PUBLIC_BASE_URL, {
    watch: watches.length ? { watch_id: watches[0]!.id, monitors: watches.map((w) => w.kind) } : null,
  });
  const code = dossierNoteCode(c.req.query("note"));
  let flag: string | null = null;
  if (code === "watched") {
    const until = watches.find((w) => w.expires_at)?.expires_at;
    flag = until ? `This address is now watched until ${day(until)}.` : DOSSIER_NOTES.watched;
  } else if (code) {
    flag = DOSSIER_NOTES[code];
  }
  const cache = doc.status === "partial" ? "no-store" : "public, max-age=300";
  return render(
    c,
    <DossierPage
      doc={doc}
      flag={flag}
      units={dossier.units}
      workStartedAt={doc.status === "partial" ? (dossier.workflow_started_at ?? dossier.created_at) : null}
      detail={dossier.resolution_detail}
      unresolved={dossier.outcome === "no_match" || dossier.outcome === "ambiguous"}
      {...pageMeta(c)}
    />,
    200,
    { "cache-control": cache },
  );
});

siteRouter.post("/d/:id/upgrade", async (c) => {
  const id = c.req.param("id");
  const dossier = await getDossier(c.env.DB, id);
  if (!dossier) return c.text("Not found", 404);
  const result = await upgradeDossier(c.env, id, {
    admin: isAdmin(c),
    ipHash: await visitorHash(c.env, c.req.header("CF-Connecting-IP")),
  });
  if (!result.ok && result.status === 404) return c.text("Not found", 404);
  const note = !result.ok
    ? result.error === "already_upgraded"
      ? "already"
      : result.error === "rate_limited"
        ? "limit"
        : result.error === "budget_paused"
          ? "budget"
          : "failed"
    : "started";
  return c.redirect(`/d/${id}?note=${note}`, 303);
});

siteRouter.post("/d/:id/watch", async (c) => {
  const id = c.req.param("id");
  const admin = isAdmin(c);
  const result = await watchDossier(c.env, id, {
    admin,
    ipHash: admin ? null : await visitorHash(c.env, c.req.header("CF-Connecting-IP")),
  });
  if (!result.ok && result.status === 404) return c.text("Not found", 404);
  const note = result.ok
    ? "watched"
    : result.error === "already_watched"
      ? "watched"
      : result.error === "watch_capacity"
        ? "no_slot"
        : result.error === "rate_limited"
          ? "watch_limit"
          : "failed";
  return c.redirect(`/d/${id}?note=${note}`, 303);
});

export { siteRouter };
