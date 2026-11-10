import { expirePublicDossiers } from "./db/dossiers";
import { AGENT_SLOT_STALE_MS } from "./db/inflight";
import { dueForExpiry, listWatches, setWatchStatus } from "./db/watches";
import { finishAgentSections } from "./dossier/agentSteps";
import type { Env } from "./env";
import { deleteMonitor, listMonitors } from "./tinyfish/monitor";

/** Performs the hourly maintenance without fetching city pages. */
export async function runCron(env: Env): Promise<void> {
  const now = new Date();
  try {
    for (const watch of await dueForExpiry(env.DB,now.toISOString())) {
      if (!watch.monitor_id) continue;
      try { await deleteMonitor(env,watch.monitor_id); await setWatchStatus(env.DB,watch.id,"expired"); }
      catch { console.error("monitor expiry failed",watch.id); }
    }
  } catch { console.error("watch expiry failed"); }
  try {
    await expirePublicDossiers(env.DB,now.toISOString());
    const pending = await env.DB.prepare("SELECT evidence_key FROM pending_evidence_deletions").all<{evidence_key:string}>();
    for (const {evidence_key:key} of pending.results) {
      try {
        const referenced = await env.DB.prepare("SELECT 1 FROM sections WHERE evidence_key=? LIMIT 1").bind(key).first();
        if (!referenced) await env.STORE.delete(key);
        await env.DB.prepare("DELETE FROM pending_evidence_deletions WHERE evidence_key=?").bind(key).run();
      } catch { console.error("evidence deletion failed",key); }
    }
  } catch { console.error("dossier expiry failed"); }
  try {
    const before = new Date(now.getTime()-AGENT_SLOT_STALE_MS).toISOString();
    await env.DB.prepare("DELETE FROM agent_inflight WHERE id=1 AND COALESCE(started_at,'') < ?").bind(before).run();
  } catch { console.error("stale slot cleanup failed"); }
  try {
    const before = new Date(now.getTime()-30*60*1000).toISOString();
    const stale = `SELECT d.id FROM dossiers d WHERE d.status='partial' AND d.workflow_id IS NOT NULL
      AND d.workflow_started_at IS NOT NULL AND d.workflow_started_at < ?1
      AND EXISTS (SELECT 1 FROM sections s WHERE s.dossier_id=d.id AND s.status='pending')
      AND NOT EXISTS (SELECT 1 FROM sections s WHERE s.dossier_id=d.id AND s.checked_at > ?1)`;
    // Only the sheets are marked. What that makes of the dossier is decided just below, by the same rule
    // as everywhere else: complete with gaps when something was read, failed only when nothing was.
    await env.DB.prepare(`UPDATE sections SET status='error',error='workflow_timeout' WHERE status='pending' AND dossier_id IN (${stale})`).bind(before).run();
  } catch { console.error("workflow timeout cleanup failed"); }
  try {
    const stuck = await env.DB.prepare(
      `SELECT d.id FROM dossiers d WHERE d.status = 'partial'
        AND NOT EXISTS (SELECT 1 FROM sections s WHERE s.dossier_id = d.id AND s.status = 'pending')`,
    ).all<{ id: string }>();
    for (const { id } of stuck.results) {
      try { await finishAgentSections(env, id); }
      catch { console.error("stuck dossier settle failed", id); }
    }
  } catch { console.error("stuck dossier settle failed"); }
  try {
    const owned = new Map((await listWatches(env.DB,{status:"active"})).filter(w=>w.monitor_id).map(w=>[w.monitor_id!,w]));
    const remote = await listMonitors(env);
    const seen = new Set<string>();
    for (const monitor of remote) if (owned.has(monitor.id)) { seen.add(monitor.id); if (monitor.status !== "active") console.warn("owned monitor unhealthy",owned.get(monitor.id)!.id,monitor.status); }
    for (const [id,watch] of owned) if (!seen.has(id)) console.warn("owned monitor missing",watch.id);
  } catch { console.error("monitor health check failed"); }
}
