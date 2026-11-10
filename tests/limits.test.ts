import { describe, expect, it } from "vitest";
import * as limits from "../src/core/limits";

describe("limits", () => {
  it("holds exactly the spec's constants with their values", () => {
    expect({ ...limits }).toEqual({
      AGENT_MAX_STEPS: 14,
      AGENT_SECTION_MAX_USD: 0.224,
      AGENT_MAX_DURATION_SECONDS: 170,
      MAX_MONITORS: 10,
      CURATED_ADDRESSES: 3,
      PUBLIC_WATCH_SLOTS: 4,
      PUBLIC_WATCH_TTL_DAYS: 7,
      PUBLIC_DOSSIERS_PER_IP_PER_DAY: 3,
      PUBLIC_UPGRADES_PER_IP_PER_DAY: 1,
      PUBLIC_WATCHES_PER_IP_PER_DAY: 1,
      CACHE_HOURS: 24,
      PUBLIC_DOSSIER_TTL_DAYS: 7,
      FLOOD_RETRY_DAYS: 7,
      FETCH_RETRY_ON_LOADING: 3,
      FETCH_RETRY_DELAY_MS: 10000,
      DEEP_ROWS_MAX: 100,
      PUBLIC_AGENT_PAUSE_USD: 6,
      SPEND_PAUSE_USD: 8,
    });
  });
});
