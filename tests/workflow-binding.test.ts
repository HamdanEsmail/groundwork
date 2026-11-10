import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker, { DossierAgentWorkflow } from "../src/index";

// The Workflow binding and its exported class are what Task 7 builds on.
describe("workflow binding", () => {
  it("exports DossierAgentWorkflow from the main module", () => {
    expect(typeof DossierAgentWorkflow).toBe("function");
    expect(DossierAgentWorkflow.name).toBe("DossierAgentWorkflow");
    expect(typeof worker.fetch).toBe("function");
    expect(typeof worker.scheduled).toBe("function");
  });

  it("binds DOSSIER_WORKFLOW with the Workflow methods", () => {
    expect(typeof env.DOSSIER_WORKFLOW.create).toBe("function");
    expect(typeof env.DOSSIER_WORKFLOW.get).toBe("function");
  });
});
