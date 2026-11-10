// The one-Agent-run-in-flight rule (spec 3). The Workflow runs its Agent sections one after
// another; this row also keeps the deep run (and any second dossier) from starting a run while
// another is going. The table holds at most one row (`id = 1`).
//
// The holder is an opaque token the caller makes up, `<dossierId>:<sectionId>`: the slot is
// taken before the run is started, so the run id does not exist yet. It is stored in the
// column called `run_id`.

/** A hold older than this is taken to be a crashed step and may be taken over. */
export const AGENT_SLOT_STALE_MS = 10 * 60 * 1000;

/**
 * Tries to take the slot for `holder`. True only when this call now holds it: the row was
 * absent, or its `started_at` is older than AGENT_SLOT_STALE_MS (or missing). Otherwise nothing
 * changes and the answer is false. One statement, so two concurrent calls cannot both win; an
 * ISO-8601 UTC timestamp compares correctly as text. Not re-entrant: a holder that still holds
 * a fresh slot is told false like anyone else.
 */
export async function acquireAgentSlot(db: D1Database, holder: string, opts: { now?: Date } = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - AGENT_SLOT_STALE_MS).toISOString();
  const row = await db
    .prepare(
      `INSERT INTO agent_inflight (id, run_id, started_at) VALUES (1, ?1, ?2)
       ON CONFLICT (id) DO UPDATE SET run_id = excluded.run_id, started_at = excluded.started_at
       WHERE COALESCE(agent_inflight.started_at, '') < ?3
       RETURNING run_id`,
    )
    .bind(holder, now.toISOString(), staleBefore)
    .first<{ run_id: string }>();
  // When the conflict's WHERE is false nothing is written and nothing is returned.
  return row?.run_id === holder;
}

/**
 * Frees the slot, but only if `holder` still holds it: a holder that went stale cannot free a
 * newer holder's slot. True when this call freed it, false when it did nothing (the slot was free,
 * or someone else holds it).
 */
export async function releaseAgentSlot(db: D1Database, holder: string): Promise<boolean> {
  const row = await db
    .prepare("DELETE FROM agent_inflight WHERE id = 1 AND run_id = ?1 RETURNING run_id")
    .bind(holder)
    .first<{ run_id: string }>();
  return row !== null;
}

/** Who holds the slot now and since when, or null when it is free (for tests and the cron). */
export async function slotHolder(db: D1Database): Promise<{ holder: string | null; startedAt: string | null } | null> {
  const row = await db
    .prepare("SELECT run_id, started_at FROM agent_inflight WHERE id = 1")
    .first<{ run_id: string | null; started_at: string | null }>();
  return row === null ? null : { holder: row.run_id, startedAt: row.started_at };
}
