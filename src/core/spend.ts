// The spend ledger. Every TinyFish call appends one row; the totals feed the
// spend pause (SPEND_PAUSE_USD) and the public /api/stats.

export type SpendKind = "agent_step" | "monitor_check" | "screenshot" | "fetch" | "search";

/** US dollars per unit of each kind. */
export const PRICES: Record<SpendKind, number> = {
  agent_step: 0.016,
  monitor_check: 0.005,
  screenshot: 0.002,
  fetch: 0,
  search: 0,
};

/** Appends one row to the ledger. `ref` says what the money was spent on (a check id, a run id, a watch id). */
export async function recordSpend(
  db: D1Database,
  kind: SpendKind,
  amountUsd: number,
  ref: string,
): Promise<void> {
  await db
    .prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), kind, amountUsd, ref, new Date().toISOString())
    .run();
}

/**
 * Books one Agent run on the ledger, keyed by TinyFish run id. A later call with the same id
 * replaces the amount (a ceiling booked when the true step count was unknown yields to the
 * figure read from the run). A true figure of 0 with no existing row writes nothing.
 */
export async function bookAgentRunSpend(db: D1Database, runId: string, amountUsd: number): Promise<void> {
  const existing = await db
    .prepare("SELECT id FROM spend WHERE kind = 'agent_step' AND ref = ? ORDER BY at, rowid LIMIT 1")
    .bind(runId)
    .first<{ id: string }>();
  if (existing) {
    if (amountUsd > 0) {
      await db.prepare("UPDATE spend SET amount_usd = ? WHERE id = ?").bind(amountUsd, existing.id).run();
    } else {
      await db.prepare("DELETE FROM spend WHERE id = ?").bind(existing.id).run();
    }
    await db.prepare("DELETE FROM spend WHERE kind = 'agent_step' AND ref = ? AND id != ?")
      .bind(runId, existing.id).run();
    return;
  }
  if (amountUsd > 0) await recordSpend(db, "agent_step", amountUsd, runId);
}

/** Total US dollars spent so far, across every kind. */
export async function totalSpend(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(SUM(amount_usd), 0) AS total FROM spend").first<{ total: number }>();
  return row?.total ?? 0;
}

/** US dollars spent per kind. Every kind is present, zero when nothing was spent on it. */
export async function spendByKind(db: D1Database): Promise<Record<SpendKind, number>> {
  const totals = Object.fromEntries(Object.keys(PRICES).map((kind) => [kind, 0])) as Record<SpendKind, number>;
  const { results } = await db
    .prepare("SELECT kind, COALESCE(SUM(amount_usd), 0) AS total FROM spend GROUP BY kind")
    .all<{ kind: string; total: number }>();
  for (const row of results) {
    if (row.kind in totals) totals[row.kind as SpendKind] = row.total;
  }
  return totals;
}
