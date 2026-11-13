// HTTP endpoints for creating, reading, and upgrading dossiers.
import { Hono } from "hono";
import { isAdmin, visitorHash } from "../auth";
import { AGENT_SECTION_MAX_USD } from "../core/limits";
import { getDossier, updateDossier } from "../db/dossiers";
import { listWatches } from "../db/watches";
import { getSections, upsertSection } from "../db/sections";
import { createDossier, DossierError, startAgentSections, type CreateInput } from "../dossier/build";
import { toDossierDocument } from "../dossier/document";
import { upgradeDossier } from "../dossier/upgrade";
import type { Env } from "../env";
import { DEEP_SECTION_ID, STANDARD_AGENT_SECTION_IDS } from "../sections/index";
import type { SectionId } from "../sections/types";

const COST_PRECISION = 1000;

export const dossiersRouter = new Hono<{ Bindings: Env }>();
function valid(value: unknown): value is CreateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => !["address", "opa_account", "unit", "tier", "fresh", "callback_url", "curated"].includes(k))) return false;
  if ((v.address === undefined) === (v.opa_account === undefined)) return false;
  if (v.address !== undefined && (typeof v.address !== "string" || !v.address.trim() || v.address.length > 200)) return false;
  if (v.opa_account !== undefined && (typeof v.opa_account !== "string" || !/^\d{9}$/.test(v.opa_account))) return false;
  // A unit is a few characters ("4B", "PH-12"). It is stored and sent on to the city's atlas, so it has a limit as the address has.
  if (v.unit !== undefined && (typeof v.unit !== "string" || v.unit.length > 20)) return false;
  if (v.tier !== undefined && !["free", "standard", "deep"].includes(v.tier as string)) return false;
  if (v.fresh !== undefined && typeof v.fresh !== "boolean") return false;
  if (v.curated !== undefined && typeof v.curated !== "boolean") return false;
  if (v.callback_url !== undefined) {
    if (typeof v.callback_url !== "string") return false;
    try { if (new URL(v.callback_url).protocol !== "https:") return false; } catch { return false; }
  }
  return true;
}
dossiersRouter.post("/api/dossiers", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  if (!valid(body)) return c.json({ error: "invalid_input", detail: "Invalid dossier request" }, 400);
  const admin = isAdmin(c);
  if (!admin && body.callback_url !== undefined) {
    return c.json({ error: "invalid_input", detail: "callbacks need the admin token" }, 400);
  }
  try {
    // The platform stops a request whose client has gone, which would leave a dossier half read. Work
    // handed to waitUntil is allowed to finish.
    const work = createDossier(c.env, body, { admin, ipHash: await visitorHash(c.env,
      c.req.header("CF-Connecting-IP")) });
    c.executionCtx.waitUntil(work.catch(() => undefined));
    const result = await work;
    if (result.outcome !== "resolved") return c.json({ dossier_id: result.dossierId, status: result.status,
      outcome: result.outcome, ...result.detail, report_url: result.reportUrl }, 200);
    return c.json({ dossier_id: result.dossierId, status: result.status, outcome: result.outcome, cached: result.cached,
      tier: result.tier, estimated_cost_usd: result.estimatedCostUsd, report_url: result.reportUrl, ...(!admin && body.tier
        && body.tier !== "free" ? { requested_tier: body.tier } : {}) }, 202);
  } catch (err) {
    if (err instanceof DossierError) return c.json(err.body, err.status as 429 | 502);
    throw err;
  }
});
dossiersRouter.get("/api/dossiers/:id", async (c) => {
  const dossier = await getDossier(c.env.DB, c.req.param("id"));
  if (!dossier) return c.json({ error: "not_found" }, 404);
  const watches = dossier.opa_account ? await listWatches(c.env.DB, { opa: dossier.opa_account, status: "active" }) : [];
  return c.json(toDossierDocument(dossier, await getSections(c.env.DB, dossier.id), c.env.PUBLIC_BASE_URL, {watch: watches.length ? {watch_id:watches[0]!.id, monitors:watches.map(w=>w.kind)} : null}));
});
dossiersRouter.post("/api/dossiers/:id/upgrade", async (c) => {
  const id = c.req.param("id");
  const result = await upgradeDossier(c.env, id, { admin: isAdmin(c), ipHash: await visitorHash(c.env, c.req.header("CF-Connecting-IP")) });
  if (!result.ok) {
    const body: Record<string, unknown> = { error: result.error };
    if (result.reason) body.reason = result.reason;
    if (result.limit !== undefined) body.limit = result.limit;
    return c.json(body, result.status);
  }
  return c.json({ dossier_id: id, status: "partial", estimated_cost_usd: result.estimatedCostUsd, sections: result.pending }, 202);
});

// Reads again the Agent sections that ended in error. A section whose run was paid for and never
// read is read from that run; the others start a new run. Sections that are ok are left alone.
dossiersRouter.post("/api/dossiers/:id/retry", async (c) => {
  if (!isAdmin(c)) return c.json({ error: "admin_required" }, 403);
  const dossier = await getDossier(c.env.DB, c.req.param("id"));
  if (!dossier || dossier.outcome !== "resolved") return c.json({ error: "not_found" }, 404);
  // An optional body names the sections to retry: {"sections": ["schools"]}. Without one, all that failed.
  const body: unknown = await c.req.json().catch(() => null);
  const named = body !== null && typeof body === "object" ? (body as { sections?: unknown }).sections : undefined;
  if (named !== undefined && !(Array.isArray(named) && named.every((s) => typeof s === "string"))) {
    return c.json({ error: "invalid_input", detail: "sections must be a list of section ids" }, 400);
  }
  const rows = await getSections(c.env.DB, dossier.id);
  // In the order the report shows them, whatever order the rows were written in.
  const failed: SectionId[] = [...STANDARD_AGENT_SECTION_IDS, DEEP_SECTION_ID].filter((sid) =>
    (named === undefined || (named as string[]).includes(sid))
    && rows.some((row) => row.section_id === sid && row.method === "agent" && row.status === "error"));
  if (!failed.length) return c.json({ error: "nothing_to_retry" }, 409);
  try {
    const started = await startAgentSections(c.env, dossier.id, failed);
    const now = await getDossier(c.env.DB, dossier.id);
    return c.json({ dossier_id: dossier.id, status: now?.status ?? "partial", sections: failed,
      estimated_cost_usd: Math.round(started * AGENT_SECTION_MAX_USD * COST_PRECISION) / COST_PRECISION }, 202);
  } catch (err) {
    console.error("workflow start failed", err instanceof Error ? err.name : typeof err);
    const after = await getSections(c.env.DB, dossier.id);
    for (const sid of failed) {
      if (after.some((row) => row.section_id === sid && row.status === "pending" && !row.run_id)) {
        await upsertSection(c.env.DB, dossier.id, sid, { status: "error", error: "workflow_start_failed" });
      }
    }
    return c.json({ error: "workflow_start_failed" }, 502);
  }
});

dossiersRouter.post("/api/dossiers/:id/deepen", async (c) => {
  if (!isAdmin(c)) return c.json({ error: "admin_required" }, 403);
  const dossier = await getDossier(c.env.DB, c.req.param("id"));
  if (!dossier || dossier.outcome !== "resolved") return c.json({ error: "not_found" }, 404);
  if (dossier.status !== "complete") return c.json({ error: "in_progress" }, 409);
  const deep = (await getSections(c.env.DB, dossier.id)).find((row) => row.section_id === "li_deep");
  if (deep?.status === "ok" || deep?.status === "pending") return c.json({ error: "already_deep" }, 409);
  try {
    await updateDossier(c.env.DB, dossier.id, { tier: "deep" });
    await startAgentSections(c.env, dossier.id, ["li_deep"]);
  } catch (err) {
    console.error("workflow start failed", err instanceof Error ? err.name : typeof err);
    if (deep) await upsertSection(c.env.DB, dossier.id, "li_deep", { status: deep.status, error: deep.error,
      method: deep.method, source_url: deep.source_url, checked_at: deep.checked_at, evidence_key: deep.evidence_key,
      data: deep.data, run_id: deep.run_id, spend_usd: deep.spend_usd });
    await updateDossier(c.env.DB, dossier.id, { tier: dossier.tier, status: dossier.status,
      completed_at: dossier.completed_at, workflow_id: dossier.workflow_id,
      workflow_started_at: dossier.workflow_started_at });
    return c.json({ error: "workflow_start_failed" }, 502);
  }
  return c.json({ dossier_id: dossier.id, status: "partial", estimated_cost_usd: AGENT_SECTION_MAX_USD }, 202);
});
