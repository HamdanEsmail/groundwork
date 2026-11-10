// Per-visitor daily counters behind the public rate limits (spec 7). One row per (ip_hash, UTC day).
// The handlers decide the limits; this file only counts.

export type UseField = "dossiers" | "watches" | "upgrades";

export interface UseCounts {
  dossiers: number;
  watches: number;
  upgrades: number;
}

// One fixed statement per counter, so the field name never comes from a value. Each is a single
// statement that counts only while the counter is below the limit (?3): the first use of a day inserts
// the row at 1, a later use raises the counter only if `field < limit`, and when the limit is reached the
// conflict's WHERE is false, nothing is written and no row comes back. No read-then-write race.
const CLAIM: Record<UseField, string> = {
  dossiers: `INSERT INTO public_use (ip_hash, day, dossiers) VALUES (?1, ?2, 1)
             ON CONFLICT (ip_hash, day) DO UPDATE SET dossiers = dossiers + 1 WHERE dossiers < ?3
             RETURNING dossiers AS n`,
  watches: `INSERT INTO public_use (ip_hash, day, watches) VALUES (?1, ?2, 1)
            ON CONFLICT (ip_hash, day) DO UPDATE SET watches = watches + 1 WHERE watches < ?3
            RETURNING watches AS n`,
  upgrades: `INSERT INTO public_use (ip_hash, day, upgrades) VALUES (?1, ?2, 1)
             ON CONFLICT (ip_hash, day) DO UPDATE SET upgrades = upgrades + 1 WHERE upgrades < ?3
             RETURNING upgrades AS n`,
};

// One fixed statement per counter, as above. Gives one claimed slot back; the WHERE keeps the counter at
// 0 or more and creates no row.
const RELEASE: Record<UseField, string> = {
  dossiers: "UPDATE public_use SET dossiers = dossiers - 1 WHERE ip_hash = ?1 AND day = ?2 AND dossiers > 0",
  watches: "UPDATE public_use SET watches = watches - 1 WHERE ip_hash = ?1 AND day = ?2 AND watches > 0",
  upgrades: "UPDATE public_use SET upgrades = upgrades - 1 WHERE ip_hash = ?1 AND day = ?2 AND upgrades > 0",
};

/** The UTC day as YYYY-MM-DD. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Takes one slot of `field` for this visitor today if they have fewer than `limit` used. True when this
 * call got a slot (and it is counted); false when the limit is reached (nothing is counted). Atomic: two
 * concurrent claims at limit - 1 give exactly one true. A limit below 1 is always false; a fractional
 * limit rounds down. Throws on a field that is not a counter.
 */
export async function claimPublicUse(
  db: D1Database,
  ipHash: string,
  field: UseField,
  limit: number,
  opts: { now?: Date } = {},
): Promise<boolean> {
  if (!Object.hasOwn(CLAIM, field)) throw new Error(`public_use has no counter "${String(field)}"`);
  // The insert path writes 1 before the limit is looked at, so a limit under 1 is refused up front.
  const max = Math.floor(limit);
  if (!(max >= 1)) return false;
  const row = await db
    .prepare(CLAIM[field])
    .bind(ipHash, utcDay(opts.now ?? new Date()), max)
    .first<{ n: number }>();
  return row !== null;
}

/**
 * Gives back one slot of `field` that `claimPublicUse` took, for a caller whose action was refused after the
 * claim. Pass the same `now` as the claim so a claim just before midnight UTC is refunded on its own day.
 * The counter never goes below 0; true when it was lowered, false when it was already 0 (or the visitor has no
 * row that day). Throws on a field that is not a counter.
 */
export async function releasePublicUse(db: D1Database, ipHash: string, field: UseField, opts: { now?: Date } = {}): Promise<boolean> {
  if (!Object.hasOwn(RELEASE, field)) throw new Error(`public_use has no counter "${String(field)}"`);
  const result = await db
    .prepare(RELEASE[field])
    .bind(ipHash, utcDay(opts.now ?? new Date()))
    .run();
  return result.meta.changes > 0;
}

/** What this visitor has used today; zeros when they have not used anything. */
export async function today(db: D1Database, ipHash: string, opts: { now?: Date } = {}): Promise<UseCounts> {
  const row = await db
    .prepare("SELECT dossiers, watches, upgrades FROM public_use WHERE ip_hash = ? AND day = ?")
    .bind(ipHash, utcDay(opts.now ?? new Date()))
    .first<UseCounts>();
  return row ?? { dossiers: 0, watches: 0, upgrades: 0 };
}
