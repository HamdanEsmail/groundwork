import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { acquireAgentSlot, AGENT_SLOT_STALE_MS, releaseAgentSlot, slotHolder } from "../src/db/inflight";

const T0 = new Date("2026-11-03T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM agent_inflight").run();
});

describe("agent slot", () => {
  it("is stale after 10 minutes", () => {
    expect(AGENT_SLOT_STALE_MS).toBe(10 * 60 * 1000);
  });

  it("is empty at first, and the first acquire takes it and records the holder and the start time", async () => {
    expect(await slotHolder(env.DB)).toBeNull();
    expect(await acquireAgentSlot(env.DB, "dossier-1:tax", { now: T0 })).toBe(true);
    expect(await slotHolder(env.DB)).toEqual({ holder: "dossier-1:tax", startedAt: T0.toISOString() });
    const { results } = await env.DB.prepare("SELECT id, run_id, started_at FROM agent_inflight").all();
    expect(results).toEqual([{ id: 1, run_id: "dossier-1:tax", started_at: T0.toISOString() }]);
  });

  it("a fresh row blocks every other holder and changes nothing", async () => {
    await acquireAgentSlot(env.DB, "a:tax", { now: T0 });
    expect(await acquireAgentSlot(env.DB, "b:tax", { now: at(1_000) })).toBe(false);
    expect(await acquireAgentSlot(env.DB, "c:schools", { now: at(60_000) })).toBe(false);
    expect(await slotHolder(env.DB)).toEqual({ holder: "a:tax", startedAt: T0.toISOString() });
  });

  it("the holder itself does not get the slot a second time (acquire is not re-entrant)", async () => {
    expect(await acquireAgentSlot(env.DB, "a:tax", { now: T0 })).toBe(true);
    expect(await acquireAgentSlot(env.DB, "a:tax", { now: at(1_000) })).toBe(false);
    expect(await slotHolder(env.DB)).toEqual({ holder: "a:tax", startedAt: T0.toISOString() });
  });

  it("a row older than 10 minutes is stale and is taken over; exactly 10 minutes is not yet stale", async () => {
    await acquireAgentSlot(env.DB, "old:tax", { now: T0 });
    expect(await acquireAgentSlot(env.DB, "new:tax", { now: at(AGENT_SLOT_STALE_MS - 1) })).toBe(false);
    expect(await acquireAgentSlot(env.DB, "new:tax", { now: at(AGENT_SLOT_STALE_MS) })).toBe(false);
    expect(await slotHolder(env.DB)).toEqual({ holder: "old:tax", startedAt: T0.toISOString() });

    const takeover = at(AGENT_SLOT_STALE_MS + 1);
    expect(await acquireAgentSlot(env.DB, "new:tax", { now: takeover })).toBe(true);
    expect(await slotHolder(env.DB)).toEqual({ holder: "new:tax", startedAt: takeover.toISOString() });
    // The takeover is a fresh hold: the next caller is blocked again.
    expect(await acquireAgentSlot(env.DB, "third:tax", { now: at(AGENT_SLOT_STALE_MS + 2) })).toBe(false);
  });

  it("a row with no start time counts as stale, so it can never block the slot for good", async () => {
    await env.DB.prepare("INSERT INTO agent_inflight (id, run_id, started_at) VALUES (1, 'broken', NULL)").run();
    expect(await acquireAgentSlot(env.DB, "a:tax", { now: T0 })).toBe(true);
    expect(await slotHolder(env.DB)).toEqual({ holder: "a:tax", startedAt: T0.toISOString() });
  });

  it("uses the clock when no time is given", async () => {
    const before = Date.now();
    expect(await acquireAgentSlot(env.DB, "a:tax")).toBe(true);
    const held = await slotHolder(env.DB);
    expect(Date.parse(held!.startedAt!)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(held!.startedAt!)).toBeLessThanOrEqual(Date.now());
  });

  it("release by the holder frees the slot and returns true, and the next acquire succeeds", async () => {
    await acquireAgentSlot(env.DB, "a:tax", { now: T0 });
    expect(await releaseAgentSlot(env.DB, "a:tax")).toBe(true);
    expect(await slotHolder(env.DB)).toBeNull();
    expect(await acquireAgentSlot(env.DB, "b:tax", { now: at(1_000) })).toBe(true);
    expect((await slotHolder(env.DB))?.holder).toBe("b:tax");
  });

  it("release by anyone else does nothing and returns false; so does releasing an empty slot", async () => {
    await acquireAgentSlot(env.DB, "a:tax", { now: T0 });
    expect(await releaseAgentSlot(env.DB, "b:tax")).toBe(false);
    expect(await slotHolder(env.DB)).toEqual({ holder: "a:tax", startedAt: T0.toISOString() });
    expect(await releaseAgentSlot(env.DB, "a:tax")).toBe(true);
    // Already free: nothing to release.
    expect(await releaseAgentSlot(env.DB, "a:tax")).toBe(false);
    expect(await slotHolder(env.DB)).toBeNull();
  });

  it("a stale holder cannot release the slot a newer holder took over", async () => {
    await acquireAgentSlot(env.DB, "old:tax", { now: T0 });
    expect(await acquireAgentSlot(env.DB, "new:tax", { now: at(AGENT_SLOT_STALE_MS + 1) })).toBe(true);
    // The stale holder finishes late: its release returns false and leaves the newer hold alone.
    expect(await releaseAgentSlot(env.DB, "old:tax")).toBe(false);
    expect((await slotHolder(env.DB))?.holder).toBe("new:tax");
    expect(await releaseAgentSlot(env.DB, "new:tax")).toBe(true);
    expect(await slotHolder(env.DB)).toBeNull();
  });

  it("two concurrent acquires: exactly one gets the slot", async () => {
    const results = await Promise.all([acquireAgentSlot(env.DB, "a:tax", { now: T0 }), acquireAgentSlot(env.DB, "b:tax", { now: T0 })]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results[0] ? "a:tax" : "b:tax";
    expect((await slotHolder(env.DB))?.holder).toBe(winner);
  });

  it("many concurrent acquires, on an empty slot and on a stale one: still exactly one winner each time", async () => {
    const holders = ["a", "b", "c", "d", "e", "f"].map((h) => `${h}:tax`);
    const empty = await Promise.all(holders.map((h) => acquireAgentSlot(env.DB, h, { now: T0 })));
    expect(empty.filter(Boolean)).toHaveLength(1);

    const later = at(AGENT_SLOT_STALE_MS + 5_000);
    const stale = await Promise.all(holders.map((h) => acquireAgentSlot(env.DB, `${h}2`, { now: later })));
    expect(stale.filter(Boolean)).toHaveLength(1);
    expect((await slotHolder(env.DB))?.holder).toBe(`${holders[stale.indexOf(true)]}2`);
  });
});
