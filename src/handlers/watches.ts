import { Hono } from "hono";
import { isAdmin, visitorHash } from "../auth";
import { getDossier } from "../db/dossiers";
import { listWatches, setWatchStatus } from "../db/watches";
import { watchDossier } from "../dossier/watch";
import type { Env } from "../env";
import { deleteMonitor } from "../tinyfish/monitor";

export const watchesRouter = new Hono<{ Bindings: Env }>();
watchesRouter.post("/api/dossiers/:id/watch", async (c) => {
  const admin = isAdmin(c);
  const raw: unknown = await c.req.json().catch(() => ({}));
  const watchBody = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const result = await watchDossier(c.env, c.req.param("id"), {
    admin,
    ipHash: admin ? null : await visitorHash(c.env, c.req.header("CF-Connecting-IP")),
  }, watchBody);
  if (!result.ok) {
    const body: Record<string, unknown> = { error: result.error };
    if (result.detail) body.detail = result.detail;
    if (result.limit !== undefined) body.limit = result.limit;
    return c.json(body, result.status);
  }
  return c.json({ watch_id: result.watch_id, monitors: result.monitors }, 201);
});
watchesRouter.delete("/api/dossiers/:id/watch", async c => {
  const d = await getDossier(c.env.DB,c.req.param("id"));
  if (!d?.opa_account) return c.json({error:"not_found"},404);
  const admin = isAdmin(c);
  const ownerHash = admin ? null : await visitorHash(c.env,c.req.header("CF-Connecting-IP"));
  const watches = await listWatches(c.env.DB,{opa:d.opa_account,status:"active"});
  if (!admin && watches.some(w=>w.added_by !== "public" || !w.owner_hash || w.owner_hash !== ownerHash)) return c.json({error:"forbidden"},403);
  let failed = false;
  for (const w of watches) {
    if (!admin && w.added_by !== "public") continue;
    if (!w.monitor_id) { failed = true; continue; }
    try { await deleteMonitor(c.env,w.monitor_id); await setWatchStatus(c.env.DB,w.id,"removed"); } catch { failed = true; }
  }
  return failed ? c.json({error:"monitor_delete_failed"},502) : c.json({ok:true});
});
