export interface Env {
  DB: D1Database;
  STORE: R2Bucket;
  DOSSIER_WORKFLOW: Workflow<{ dossierId: string; sections: string[]; evidence?: boolean }>;
  TINYFISH_API_KEY: string;
  ADMIN_TOKEN: string;
  WEBHOOK_SECRET: string;
  PUBLIC_BASE_URL: string;
}
