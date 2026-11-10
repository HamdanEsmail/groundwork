import { Hono } from "hono";
import { runCron } from "./cron";
import { adminOnly } from "./auth";
import { PUBLIC_AGENT_PAUSE_USD } from "./core/limits";
import { spendByKind, totalSpend } from "./core/spend";
import { DossierAgentWorkflow } from "./dossier/workflow";
import type { Env } from "./env";
import { dossiersRouter } from "./handlers/dossiers";
import { watchesRouter } from "./handlers/watches";
import { webhooksRouter } from "./handlers/webhooks";
import { readRouter } from "./handlers/read";
import { objectsRouter } from "./handlers/objects";
import { siteNotFound, siteRouter } from "./site/router";

const app = new Hono<{ Bindings: Env }>();

app.route("/", siteRouter);
app.route("/", dossiersRouter);
app.route("/", objectsRouter);
app.route("/", watchesRouter);
app.route("/", webhooksRouter);
app.route("/", readRouter);

// Counts and spend totals across stored dossiers.
app.get("/api/stats", async (c) => {
  const counts = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM dossiers) AS dossiers,
       (SELECT COUNT(*) FROM watches) AS watches,
       (SELECT COUNT(*) FROM events) AS events`,
  ).first<{ dossiers: number; watches: number; events: number }>();
  const { results } = await c.env.DB.prepare("SELECT status, COUNT(*) AS n FROM sections GROUP BY status").all<{
    status: string | null;
    n: number;
  }>();
  const sections: Record<string, number> = {};
  for (const row of results) sections[row.status ?? "unknown"] = row.n;
  const spend = await totalSpend(c.env.DB);
  const eventRows = await c.env.DB.prepare("SELECT kind, COUNT(*) AS n FROM events GROUP BY kind").all<{kind:string|null;n:number}>();
  const eventKinds: Record<string,number> = {};
  for (const row of eventRows.results) eventKinds[row.kind ?? "unknown"] = row.n;
  // Sums of cents-and-fractions pick up floating-point dust (2.7199999999999998): print four decimals.
  const money = (n: number) => Math.round(n * 1e4) / 1e4;
  const byKind = Object.fromEntries(Object.entries(await spendByKind(c.env.DB)).map(([kind, usd]) => [kind, money(usd)]));
  return c.json({
    events_by_kind: eventKinds, spend_by_kind: byKind,
    cost_per_dossier_usd: counts?.dossiers ? money(spend / counts.dossiers) : 0,
    dossiers: counts?.dossiers ?? 0,
    sections,
    watches: counts?.watches ?? 0,
    events: counts?.events ?? 0,
    spend_usd: money(spend),
    public_paused: spend >= PUBLIC_AGENT_PAUSE_USD,
  });
});

app.post("/api/admin/ping", adminOnly, (c) => c.json({ ok: true }));

app.notFound((c) => siteNotFound(c));

async function scheduled(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> { await runCron(env); }

export { app, DossierAgentWorkflow };

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
