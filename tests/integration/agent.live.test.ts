import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { assessmentHistoryAdapter } from "../../src/sections/assessmentHistory";
import { runAgentToCompletion } from "../../src/tinyfish/agent";

it.skipIf(!env.LIVE_TINYFISH_API_KEY)("reads an assessment history", async () => {
  const ctx = { address: "1234 Market St", opa: "883309050" };
  const result = await runAgentToCompletion({ ...env, TINYFISH_API_KEY: env.LIVE_TINYFISH_API_KEY! }, {
    url: assessmentHistoryAdapter.url(ctx), goal: assessmentHistoryAdapter.goal!(ctx), outputSchema: assessmentHistoryAdapter.outputSchema!,
  }, { pollEveryMs: 5000, maxWaitMs: 240_000 });
  expect(result.status).toBe("COMPLETED");
  expect(result.numOfSteps).toBeLessThanOrEqual(14);
  expect(assessmentHistoryAdapter.parseResult!(result.result)).not.toBeNull();
}, 300_000);
