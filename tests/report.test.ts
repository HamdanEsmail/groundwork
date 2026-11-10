// The old string-template report is unused. Its proofs now live in tests/site.test.ts.
import { describe, expect, it } from "vitest";
import { callWorker } from "./helpers/app";

describe("GET /d/:id", () => {
  it("answers 404 for an unknown dossier", async () => {
    expect((await callWorker("/d/nope")).status).toBe(404);
  });
});
