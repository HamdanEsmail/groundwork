import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { screenshotFullPage } from "../../src/tinyfish/browser";

it.skipIf(!env.LIVE_TINYFISH_API_KEY)("captures an atlas page", async () => {
  const shot = await screenshotFullPage({ ...env, TINYFISH_API_KEY: env.LIVE_TINYFISH_API_KEY! }, "https://atlas.phila.gov/1234%20Market%20St/property");
  expect(shot.bytes.byteLength).toBeGreaterThan(0);
  expect(shot.height).toBeGreaterThan(0);
}, 120_000);
