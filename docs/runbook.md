# Runbook

These commands change remote resources and make live calls. Use Node 24 or newer, a Cloudflare account with Workers, D1, R2 and Workflows enabled, and a TinyFish account. Run the PowerShell commands from the project root.

## Create and configure

```powershell
npm ci
npx.cmd wrangler d1 create groundwork
npx.cmd wrangler r2 bucket create groundwork
```

Copy the returned D1 `database_id` into `wrangler.jsonc`. Set `vars.PUBLIC_BASE_URL` there to the actual HTTPS Worker origin, without a trailing slash. Keep the configured R2 bucket and Workflow binding names. The deploy creates the configured Workflow.

Set secrets interactively; do not put their values in the repository:

```powershell
npx.cmd wrangler secret put TINYFISH_API_KEY
npx.cmd wrangler secret put ADMIN_TOKEN
npx.cmd wrangler secret put WEBHOOK_SECRET
npm run migrate:remote
npm run deploy
```

Set `$base` to the deployed origin and read the admin token without echoing it:

```powershell
$base = 'https://YOUR-WORKER-ORIGIN'
$secureToken = Read-Host 'Admin token' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try { $adminToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
```

## Smoke test and demos

Choose a non-demo address owned by an organization. The public request below creates one free-tier dossier and may create screenshots. Inspect its report and source links; wait until status is complete, and investigate errors before continuing.

```powershell
$smokeAddress = Read-Host 'Non-demo organization-owned Philadelphia address'
$smoke = Invoke-RestMethod -Method Post -Uri "$base/api/dossiers" -ContentType 'application/json' -Body (@{address=$smokeAddress; tier='free'} | ConvertTo-Json)
$smoke.report_url
Invoke-RestMethod -Uri "$base/api/dossiers/$($smoke.dossier_id)"
```

Build the three deep dossiers and six watches. The script checks the total watch-row count as a conservative upper bound before starting; removed rows can cause it to refuse even if slots are free. The server separately reserves capacity at watch creation. A failed or interrupted run may have created dossiers or watches; inspect them before retrying.

```powershell
node scripts/build-demos.mjs --base $base --token $adminToken
Invoke-RestMethod -Uri "$base/api/stats"
```

Save the first real Monitor payload as a fixture only after checking it for secrets and personal information. Remove the webhook secret, credentials, personal information and unrelated identifying details, preserve the relevant payload structure, and add an offline test before relying on it. Do not paste the webhook URL into the fixture.

## Opt-in live tests

These make live TinyFish calls. Run only when authorized and no other Agent run is in flight. Supply the key through the shell, then explicitly enable and select a test. Agent runs are capped at 14 steps; a Browser screenshot uses one session. `npm run check` disables the live tests even if the opt-in variable is set.

```powershell
$env:TINYFISH_API_KEY = Read-Host 'TinyFish API key'
$env:GROUNDWORK_LIVE = '1'
npx.cmd vitest run tests/integration/fetch.live.test.ts
npx.cmd vitest run tests/integration/browser.live.test.ts
npx.cmd vitest run tests/integration/agent.live.test.ts
Remove-Item Env:GROUNDWORK_LIVE
Remove-Item Env:TINYFISH_API_KEY
```
