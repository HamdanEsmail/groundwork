import { Hono } from "hono";
import { constantTimeEqual } from "../auth";
import { PRICES, recordSpend } from "../core/spend";
import { markNotified } from "../db/events";
import { getParcelSection } from "../db/parcels";
import { upsertSection } from "../db/sections";
import { getWatchByMonitorId } from "../db/watches";
import type { Env } from "../env";
import { liAdapter } from "../sections/li";
import { propertyAdapter } from "../sections/property";
import type { SectionId } from "../sections/types";
import { isIncomplete } from "../tinyfish/fetch";

/** The Monitor run's own time when the payload names one; otherwise null and arrival order stands. */
function payloadRunTime(p: Record<string, unknown>): string | null {
  for (const key of ["finished_at", "started_at", "created_at", "timestamp"] as const) {
    const value = p[key];
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(Date.parse(value)).toISOString();
  }
  return null;
}

export const webhooksRouter = new Hono<{Bindings:Env}>();
webhooksRouter.post("/hooks/monitor/:secret", async c => {
  if (!c.env.WEBHOOK_SECRET || !constantTimeEqual(c.req.param("secret"), c.env.WEBHOOK_SECRET)) return c.body(null,404);
  const raw: unknown = await c.req.json().catch(()=>null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return c.json({error:"invalid_payload"},400);
  const p = raw as Record<string,unknown>;
  if (typeof p.id !== "string" || !p.id || p.id.length > 200 || typeof p.fetch_monitor_id !== "string" || !p.fetch_monitor_id || p.fetch_monitor_id.length > 200 || typeof p.outcome !== "string") return c.json({error:"invalid_payload"},400);
  // An outcome this code does not know is counted as a check with no change, so the sender is not made to retry.
  const watch = await getWatchByMonitorId(c.env.DB,p.fetch_monitor_id);
  if (!watch || watch.status !== "active" || !watch.opa_account || !watch.kind) return c.json({error:"unknown_monitor"},404);
  const holder=crypto.randomUUID(), started=new Date();
  const lock = await c.env.DB.prepare(`INSERT INTO monitor_processing (monitor_id,holder,started_at) VALUES (?1,?2,?3)
    ON CONFLICT(monitor_id) DO UPDATE SET holder=?2,started_at=?3 WHERE monitor_processing.started_at < ?4 RETURNING holder`)
    .bind(p.fetch_monitor_id,holder,started.toISOString(),new Date(started.getTime()-600000).toISOString()).first<{holder:string}>();
  if (!lock) return c.json({error:"monitor_busy"},503);
  try {
  const ref = `monitor:${p.fetch_monitor_id}:${p.id}`;
  if (await c.env.DB.prepare("SELECT id FROM spend WHERE kind='monitor_check' AND ref=?").bind(ref).first()) return c.json({ok:true,duplicate:true});
  if (p.outcome !== "changed") { await recordSpend(c.env.DB,"monitor_check",PRICES.monitor_check,ref); return c.json({ok:true}); }
  if (!Array.isArray(p.results) || !p.results[0] || typeof p.results[0] !== "object" || Array.isArray(p.results[0]) || typeof (p.results[0] as Record<string,unknown>).text !== "string" || (p.errors !== undefined && !Array.isArray(p.errors))) return c.json({error:"invalid_payload"},400);
  if (Array.isArray(p.errors) && p.errors.length) return c.json({error:"invalid_payload"},400);
  const text = (p.results[0] as {text:string}).text;
  if (isIncomplete(text)) { console.warn("incomplete monitor read"); await recordSpend(c.env.DB,"monitor_check",PRICES.monitor_check,ref); return c.json({ok:true,ignored:"incomplete"}); }
  const runAt = payloadRunTime(p);
  if (runAt && watch.last_applied_at && runAt < watch.last_applied_at) {
    await recordSpend(c.env.DB,"monitor_check",PRICES.monitor_check,ref);
    return c.json({ok:true,ignored:"stale"});
  }
  const now = new Date().toISOString();
  const previous = await c.env.DB.prepare("SELECT li_checked_at,address_resolved FROM parcels WHERE opa_account=?").bind(watch.opa_account).first<{li_checked_at:string|null;address_resolved:string|null}>();
  let changes;
  let afterData: unknown;
  let sectionId: "property" | "licenses_inspections";
  if (watch.kind === "li") {
    const after = liAdapter.parse!(text), before = await getParcelSection(c.env.DB,watch.opa_account,"licenses_inspections");
    if (!after) { console.warn("unrecognized monitor read"); await recordSpend(c.env.DB,"monitor_check",PRICES.monitor_check,ref); return c.json({ok:true,ignored:"unrecognized"}); }
    changes = before ? liAdapter.diff!(before,after,{now,previousReadAt:previous?.li_checked_at ?? undefined}) : [];
    afterData=after; sectionId="licenses_inspections";
  } else {
    const after = propertyAdapter.parse!(text), before = await getParcelSection(c.env.DB,watch.opa_account,"property");
    if (!after) { console.warn("unrecognized monitor read"); await recordSpend(c.env.DB,"monitor_check",PRICES.monitor_check,ref); return c.json({ok:true,ignored:"unrecognized"}); }
    changes = before ? propertyAdapter.diff!(before,after) : [];
    afterData=after; sectionId="property";
  }
  const adapter = watch.kind === "li" ? liAdapter : propertyAdapter;
  const url = adapter.url({address:previous?.address_resolved ?? watch.opa_account,opa:watch.opa_account});
  const ids = changes.map(()=>crypto.randomUUID());
  const statements = [c.env.DB.prepare("INSERT INTO spend (id,kind,amount_usd,ref,at) VALUES (?,'monitor_check',?,?,?)")
    .bind(crypto.randomUUID(),PRICES.monitor_check,ref,now)];
  for (let i=0;i<changes.length;i++) {
    const change=changes[i]!;
    statements.push(c.env.DB.prepare(`INSERT INTO events (id,opa_account,kind,summary,rows,before,after,source_url,monitor_run_id,at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(ids[i],watch.opa_account,change.kind,change.summary,JSON.stringify(change.rows),
        change.before == null ? null : JSON.stringify(change.before),change.after == null ? null : JSON.stringify(change.after),url,p.id,now));
  }
  statements.push(c.env.DB.prepare(`INSERT INTO parcels (opa_account,last_section_data,updated_at,li_checked_at) VALUES (?1,json_object(?2,json(?3)),?4,CASE WHEN ?2='licenses_inspections' THEN ?4 END)
    ON CONFLICT(opa_account) DO UPDATE SET last_section_data=json_set(COALESCE(parcels.last_section_data,'{}'),'$."' || ?2 || '"',json(?3)),updated_at=?4,li_checked_at=CASE WHEN ?2='licenses_inspections' THEN ?4 ELSE parcels.li_checked_at END`)
    .bind(watch.opa_account,sectionId,JSON.stringify(afterData),now));
  statements.push(c.env.DB.prepare("UPDATE watches SET last_applied_at = ? WHERE id = ?").bind(runAt ?? now, watch.id));
  try { await c.env.DB.batch(statements); }
  catch (err) {
    if (await c.env.DB.prepare("SELECT id FROM spend WHERE kind='monitor_check' AND ref=?").bind(ref).first()) return c.json({ok:true,duplicate:true});
    throw err;
  }
  // The change goes into the dossier the watch belongs to: the newest one we added for a watch of ours,
  // the watcher's own newest for a visitor's watch. Only when there is none does the newest of any kind take it.
  const latest = await c.env.DB.prepare(
    `SELECT id FROM dossiers WHERE opa_account = ?1 AND outcome = 'resolved'
     ORDER BY CASE WHEN ?2 = 'public' THEN (ip_hash IS NOT NULL AND ip_hash = ?3) ELSE (added_by IN ('curated', 'admin')) END DESC,
       created_at DESC, rowid DESC LIMIT 1`,
  ).bind(watch.opa_account, watch.added_by, watch.owner_hash).first<{ id: string }>();
  if (latest) {
    // The stored screenshot shows the earlier read, so it is dropped: a sheet never shows new data beside
    // a picture of the page as it was before.
    await upsertSection(c.env.DB, latest.id, sectionId as SectionId, {
      status: "ok", method: "fetch", data: afterData as never, checked_at: now, source_url: url, evidence_key: null, error: null,
    });
  }
  if (ids.length && watch.callback_url) {
    try {
      const response = await fetch(watch.callback_url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({opa_account:watch.opa_account,events:changes}),signal:AbortSignal.timeout(5000)});
      if (response.ok) for (const id of ids) await markNotified(c.env.DB,id,now);
    } catch { console.error("watch callback failed"); }
  }
  return c.json({ok:true,events:ids.length});
  } finally {
    await c.env.DB.prepare("DELETE FROM monitor_processing WHERE monitor_id=? AND holder=?").bind(p.fetch_monitor_id,holder).run();
  }
});
