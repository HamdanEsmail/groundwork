// The Workflow delegates serial Agent sections and completion to callable steps.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env";
import { runDossierSections } from "./agentSteps";

export interface DossierWorkflowParams {
  dossierId: string;
  sections: string[];
  /** When true, one evidence screenshot step runs per free section before any Agent sections. */
  evidence?: boolean;
}

export class DossierAgentWorkflow extends WorkflowEntrypoint<Env, DossierWorkflowParams> {
  /** Runs the serial steps and returns when completion is recorded, allowing section retries to exhaust safely. */
  async run(event: WorkflowEvent<DossierWorkflowParams>, step: WorkflowStep): Promise<void> {
    await runDossierSections(this.env, event.payload, step);
  }
}
