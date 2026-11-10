import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { fetchAtlas } from "../../src/tinyfish/fetch";

it.skipIf(!env.LIVE_TINYFISH_API_KEY)("reads an atlas property page", async () => {
  const result = await fetchAtlas({ ...env, TINYFISH_API_KEY: env.LIVE_TINYFISH_API_KEY! }, "1234 Market St", "property");
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.text.length).toBeGreaterThan(0);
}, 180_000);
