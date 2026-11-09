# Native Notion Engine — scoped prototype (2026-10-21)

## Purpose and status
Implements a **Commander Core-owned**, opt-in Notion REST client and OAuth connection, not a second workflow engine. Code lives in `src/notion-engine.mjs` and is integrated into `src/server-v0.3.mjs`. It is a **development candidate** in `feat/native-notion-engine-20261021`; **not merged, installed as the new candidate, signed or released**. The independent hosted Notion MCP client is authenticated on Emad-PC and live page reads are verified; the separate REST client is not yet enrolled. Dashboard, webhooks and two-way sync remain separate later integration gates.

## Notion MCP OAuth/PKCE (optional, independent client)
Notion's hosted MCP OAuth service is a distinct audience from the REST API. **Do not interchange tokens.** As of the verified public metadata probe on 2026-10-21, resource metadata is accessible at `https://mcp.notion.com/.well-known/oauth-protected-resource` (HTTP 200), and the authorization-server metadata advertises dynamic client registration, S256 PKCE, authorization and refresh token endpoints. The documentation's alternative `/mcp/.well-known/oauth-protected-resource` returned HTTP 401 from this host; the engine uses the verified working root discovery path.

Set optional `notionMcp` independently of REST `notion`:
```json
"notionMcp": {
  "enabled": true,
  "redirectUri": "http://127.0.0.1:49732/notion/mcp/callback"
}
```
`notion_mcp_status`, `notion_mcp_connect_start`, `notion_mcp_verify`, `notion_mcp_list_tools`, `notion_mcp_fetch_self`, and `notion_mcp_fetch_page` are exposed only when enabled. Connection start uses dynamic OAuth client registration and a single process-local callback session (10 minutes); owner consent must be completed manually on the official Notion page. The access and refresh tokens, user/workspace identity, and dynamically registered client ID are saved in a separate OS credential vault profile `mcp-<Commander profile>`. No reusable client secret is embedded in the installed software. `notion_mcp_verify` performs the hosted MCP initialization exchange, sends the mandatory `notifications/initialized` notification, preserves the negotiated `Mcp-Session-Id`, and can refresh an expired token. `notion_mcp_list_tools` reads bounded names only; `notion_mcp_fetch_self` calls only the advertised read-only `notion-fetch` with fixed `id=self`, returning a sanitized workspace/user/access summary. The transport bounds response streams before memory allocation and does not expose arbitrary MCP `tools/call` execution.

Local fixture tests include PKCE challenge correctness, DCR flow, invalid state/denied consent, vault isolation, token refresh, hosted MCP init and SSE parsing. The public OAuth metadata probe is real; successful account authorization and the complete live MCP tool lifecycle remain **OPEN**. Do not represent a fixture handshake as real Workspace access. For remote-to-desktop browser handoff, the callback must run on the user's own host/loopback; a callback bound to a remote server does not become accessible on the local browser without an authorized redirect architecture.

### Owner-operated login using the native Commander engine (no ChatGPT token reuse)
Run on the **same computer** that owns the localhost callback; the source checkout must be the qualified Notion feature branch. When invoking in an existing Commander profile, select the same profile name and an unused port:
```sh
node tools/notion-login.mjs --probe
node tools/notion-login.mjs --profile default --port 49732
# optional: add --open-browser to launch the OS browser on this computer
```
The first command performs only live, unauthenticated OAuth discovery and does **not** register a client or open a callback. The second performs official Notion DCR/PKCE registration, binds `127.0.0.1` for up to 10 minutes, and displays the official authorization URL. The owner opens it **on the host running this command** and approves or denies access to their Notion Workspace. The authorization code and PKCE verifier are never pasted into ChatGPT. On successful consent the OS vault stores the tokens in `mcp-<profile>`, the client verifies the MCP session and attempts the fixed read-only `notion-fetch({ id: "self" })` query. On failure, disconnection or timeout the command reports a bounded gate status; no credentials are exposed in output.

No browser focus is taken unless `--open-browser` was supplied. A link opened on another machine cannot reach the loopback callback. This is a bounded integration path for owner consent, **not** an authorization bypass and not an automatic production deployment. The read-only MCP path is separate from REST OAuth and cannot authorize the REST write test.

Official reference: https://developers.notion.com/guides/mcp/build-mcp-client

## Requirements and external authorization
1. A Notion **public connection** is registered in the Notion developer portal (requires an owner/admin with rights). Under OAuth set the exact redirect URI `http://127.0.0.1:49731/notion/callback`, or another owner-chosen local port. Use one client ID per app registration.
2. Select the minimum read-content and optionally insert-content permissions. The user must authorize the selected workspace/pages in Notion. The Notion connection in ChatGPT cannot give the Commander backend its token.
3. Configure a **per-profile** local Commander config with `notion`:
   ```json
   "notion": {
     "enabled": true,
     "clientId": "<PUBLIC_CONNECTION_CLIENT_ID>",
     "redirectUri": "http://127.0.0.1:49731/notion/callback",
     "allowWrites": false
   }
   ```
   Do not put OAuth client secrets, access tokens or refresh tokens in config or Git. Supply `REMOTE_COMMANDER_NOTION_CLIENT_SECRET` privately in the **Commander process environment** using an OS-managed secret facility. Do not paste credentials in ChatGPT or put them in command-line arguments. The example is deliberately not applied to live configuration.
4. A secure secret store is required. On Windows, current-user **DPAPI** encrypts token JSON into a private per-profile file under `~/.config/ChatGPTRemoteCommander/notion`; on Linux the `secret-tool` / libsecret user keyring is required. If a credential vault is missing/locked, connection must fail closed, not persist plaintext.
5. After restarting the **candidate** server, use `notion_status`, then `notion_connect_start`. The latter returns the Notion authorization URL and opens a 10-minute loopback callback. Open the URL in a Commander-owned browser and approve the consent page as the account owner. The callback validates OAuth `state` before consuming an authorization code; its result is saved in the OS-protected vault, never returned in tool output. The initial owner consent is not automatable or bypassable.
6. Call `notion_status` to check whether a credential is present, then `notion_verify` to confirm live Notion access, and `notion_search`, `notion_get_page` and `notion_list_block_children` for read access. The latter uses explicit cursor pagination (at most 20 blocks per call), reports nested blocks, and marks previews longer than 1000 characters as truncated; it does not claim full recursive content retrieval. `notion_create_page` is **disabled by default** and only works when `allowWrites: true`, with an explicit parent page ID and title.

## Boundaries and accepted design
- Data plane: official Notion REST API `2026-03-11` via HTTPS; no scraping, no normal-browser cookie reuse.
- OAuth: standard public integration Authorization Code flow; callback bound strictly to `127.0.0.1`, exact path and port, state expires within 10 min. Public connection setup and consent remain owner actions.
- Remote request queue: serial requests with a conservative 350 ms spacing per Commander profile; `429`/`529` and intermittent 5xx retry only for safe/read operations. If server `Retry-After` exceeds the local 30-second ceiling, fail with a deferred-retry signal instead of retrying prematurely. Non-idempotent page creation is never automatically retried after an uncertain effect.
- Existing mutation idempotency wraps page creation. OAuth authorization URLs are ephemeral process leases and intentionally bypass durable replay; repeated authorization calls return the still-live URL. No new workflow authority. Multiple Commander installations must coordinate their project writers; these per-process request queues do not offer distributed locking.
- Only narrow, structured result metadata is returned to calling agents. Tokens must not enter MCP arguments or audit logs. Conflicting requests and permission failures must not be silently reinterpreted as success.
- In a multi-user public release, use a trusted server-side OAuth broker rather than distributing a reusable client secret with desktop binaries. At this stage the secret is configured locally and never bundled.
- Separate opt-in Notion MCP PKCE/DCR now implements discovery, browser authorization and an authenticated MCP initialize probe. Full remote MCP tool routing, Workspace acceptance and rollout are still open; Notion remains hosted.
- Do not enable this experimental code in live production until exact-host, provider and cross-platform acceptance are evidenced.

## Tests
`node --check src/notion-engine.mjs`
`node --test test/notion-engine.test.mjs test/notion-mcp-engine.test.mjs test/notion-core-http.test.mjs`

The CLI's isolated argument, consent-flow and browser-launch tests live in `test/notion-login.test.mjs`. Tests use a synthetic memory vault and mocked Notion API; they do **not** establish real-account authorization. A Windows DPAPI round-trip test uses only fixture data and cleans its temporary directory. For full acceptance: live consent, read, explicitly authorized disposable-page create, restart/refresh, account isolation, Linux libsecret availability, invalid callback, rate-limit and failure recovery, host restart, and integration qualification on current product SHA.

- https://developers.notion.com/reference/get-block-children

## Official sources
- https://developers.notion.com/guides/get-started/authorization
- https://developers.notion.com/reference/create-a-token
- https://developers.notion.com/reference/refresh-a-token
- https://developers.notion.com/reference/request-limits
- https://developers.notion.com/guides/mcp/build-mcp-client

## Verification evidence — 2026-10-21

- MCP session lifecycle follow-up (current candidate): Windows focused Core/MCP/schema regression 38/38 PASS, Linux Node22 9/9 MCP unit PASS with SHA-256 identical candidate files, SECURITY_AUDIT_PASS, SMOKE_V03_PASS. Session-ID propagation, required initialized notification, read-only tools/list and fixed-identity notion-fetch self, bounded streamed reply, token rotation and denial guards are covered by mocked requests. This does not establish a live authenticated Workspace session.
- GitHub head 7b28ae4 first full CI/Canary/NoPromote failures were caused by a historical false positive on a clearly synthetic OAuth fixture bearer string. The exact byte sequence is excepted only inside test/notion-mcp-engine.test.mjs, including when a shallow installation checkout presents that file under a synthetic root Commit; the real origin Commit remains recorded as provenance, not a matching prerequisite. Other bearer tokens and files remain audited; regression probes enforce it. Fix commit a46290c audited locally PASS; hosted CI must pass separately.


- Native MCP/PKCE candidate (working tree 2026-10-21): Windows full targeted Notion/Core/MCP/schema/legacy fixture gate 36/36 PASS; Linux Node22 7/7 MCP unit PASS after byte-identical SHA-256 copy. SECURITY_AUDIT_PASS and SMOKE_V03_PASS. Public OAuth resource and authorization-server metadata verified live without credentials (S256/DCR advertised); no live owner-account consent or Workspace operations exercised.


- Windows full check: operation 63debde8-b1ed-4727-909b-170deb6435e8 TIMED_OUT after 120 seconds while running the qualification wrapper (no failure shown in captured test segment). This is NOT a full-suite PASS; the hosted CI rerun remains the acceptance gate.
- GitHub Draft PR #54 first CI attempt exposed a pre-existing HTTP fixture isolation constraint: server-v0.3.mjs had eagerly imported the new Notion module even when Notion was disabled, while test/agent-extensions-http.test.mjs copied a deliberately minimal server fixture without that optional module. The root fix switches Notion to config-gated dynamic import in the server, without changing those fixtures. Windows regression on agent-extensions-http, http-admission, Notion unit and Notion HTTP: 15/15 PASS. GitHub CI, Server Install Canary, Windows updater NoPromote and Release Sync on commit e8b9181 all completed SUCCESS (2026-10-21).


- Latest Windows selective qualification: 62/62 targeted tests PASS (Notion OAuth, authenticated call mocks, page-block pagination, native MCP exposure, legacy MCP contract, schema continuity, extension routing, and workflow roadmap). Exact command: `node --test test/notion-engine.test.mjs test/notion-core-http.test.mjs test/mcp-conformance.test.mjs test/schema-continuity-gate.test.mjs test/agent-extensions.test.mjs test/workflow-owner-roadmap.test.mjs`. `node --check` and `git diff --check` PASS on the same checkout.
- Linux aliemad-Labtop (Node 22) executed the updated Notion unit suite from an isolated private `/tmp` staging directory. The Windows-to-Linux code and test SHA-256 matched: 11 passed, 1 Windows-only DPAPI test skipped, 0 failed. This is a portable unit test, **not** real Linux keyring login or integrated MCP server testing.
- Tested OAuth state matching, one-live-session reentrancy, denied-consent listener teardown, token refresh/rotation, HTTPS redirect refusal, controlled 429/529 retries, no premature Retry-After override, disabled mutations, Windows DPAPI synthetic-token round trip, block cursor validation and truncation signals.
- REST public OAuth still requires a separately registered Notion public connection and owner-selected pages; ChatGPT connector credentials cannot be reused. Hosted-MCP OAuth supports Dynamic Client Registration without a fixed Client Secret, but live owner consent, workspace read/write, full MCP tool routing and production rollout remain **OPEN**.

### Authenticated project-page read gate — 2026-10-21

- `notion_mcp_fetch_page` is opt-in, **read-only**, and accepts only a 32-digit or hyphenated canonical Notion page UUID. The hosted provider's `notion-fetch` executes with the independently authenticated Notion MCP vault session, not a ChatGPT connector token. No arbitrary hosted `tools/call` executor or write method is exposed.
- Provider response bodies are capped at 256 KiB for validated `notion-fetch` page IDs; other arbitrary tool calls remain capped at 32 KiB. Public Commander results include only a 6,000-character content preview, truncation status and byte length. Invalid IDs and provider errors fail closed.
- Real non-mutating acceptance on Emad-PC: `ChatGPTRemoteCommander` project page was fetched with independent credentials; the same page was subsequently fetched through an **isolated real Commander server HTTP `tools/list` / `tools/call`** route. Page content/IDs and access tokens were not printed in qualification output. Fake provider and negative-input unit tests: Windows 22/22 tests PASS in focused suite including Core HTTP and login checks; Linux Node22 Notion MCP 16/16 PASS with SHA-256 identical staged files; Security Audit and Smoke PASS.
- REST OAuth remains independently unconfigured on Emad-PC (no REST client secret and no REST vault credential). This MCP page-read success does not authorize Notion REST access or any write. A controlled disposable write/read-back/cleanup is therefore a separate acceptance gate, and protected production merge/deploy remains unpromoted.

### Optional native REST Personal Access Token (PAT) enrollment — 2026-10-21

For the owner's **single-user** Commander on their own trusted PC, Notion's current official docs support a user-scoped PAT as an alternative to registering a public OAuth integration. The personal token has the creator's own page permissions and must have **Notion API** capability. A multi-user/distributed Commander product should continue to use a public OAuth connection per user. This alternative is not related to the already-authorized hosted MCP token; do not copy or exchange those audiences.

- Secure local importer: `node tools/notion-pat-import.mjs --token-stdin --profile default`. It **rejects command-line token arguments**, receives only a masked terminal prompt through stdin, verifies the token at `GET https://api.notion.com/v1/users/me` with pinned official API base/Notion-Version before persisting, and saves only the verified credential to the profile's protected Windows DPAPI/Linux libsecret REST vault. Invalid tokens and unavailable vaults fail closed. Existing OAuth/PAT credentials cannot be overwritten without explicit `--replace-existing`.
- The importer is **not** an MCP tool and the secret must never be pasted in chats, CLI arguments or repository files. On the Windows owner machine, after creating a dedicated PAT with the Notion API capability in the official Developer portal, run from this feature worktree in a local PowerShell terminal:

```powershell
$secret = Read-Host 'Notion REST PAT' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  $plain | node tools/notion-pat-import.mjs --token-stdin --profile default
} finally {
  if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  Remove-Variable plain,secret -ErrorAction SilentlyContinue
}
```

- Supported REST authentication is **opt-in** and separate from `notionMcp`. `notion_status.credentialType` reports `personal_access_token` versus `oauth` without emitting credentials. Failed verification does not disturb a pre-existing vault entry. All write calls remain disabled until `notion.allowWrites` is explicitly true; the current CLI only performs authentication, not writes.
- Windows synthetic regression for PAT verification, rejection, safe replacement and CLI argv/secret redaction passed. **Historical status only:** before owner enrollment, a real REST PAT was not yet verified; the later Windows Control Center acceptance section below records successful owner-provided PAT enrollment, REST read, and controlled sandbox write/read/Trash confirmation. See official docs: https://developers.notion.com/guides/get-started/personal-access-tokens

### Windows Control Center enrollment and live REST acceptance — 2026-10-21

- A first-class **Notion Connection** action is now in the existing Windows Remote Commander Control Center (compiled WinForms dashboard), with the same wizard independently openable through `RemoteCommander.exe --notion-connect`. The GUI opens the official owner-signed-in Notion PAT portal, supports a named Commander profile, accepts the PAT in a masked input only, asks before replacing a saved credential, verifies it through the independent REST importer and displays success/failure without printing token values. Local `--status` reports bounded connection state without returning any token, workspace data or secret. Notion REST and hosted MCP maintain separate OS vault records.
- **User installation:** after installing a compatible Core and its Windows Control Center for the same local OS user, open **Remote Commander → Notion Connection**, create a personal Notion API token, paste it into the masked field, and press **Verify and connect**. The Core-side importer is resolved from `%LOCALAPPDATA%\\ChatGPTRemoteCommander\\app\\tools\\notion-pat-import.mjs`. A developer override can be supplied for isolated previews; it is not installed or required for ordinary users. The UI does not request blanket administrator elevation or switch Chrome profiles.
- **Authenticated evidence on Emad-PC:** after the owner entered a PAT into the masked Control Center wizard, a separate `--status --profile default` verification reported `NOTION_REST_STATUS CONNECTED PAT VAULT_READY`. Live REST `GET /v1/users/me` PASS, real authorized Commander project page REST GET PASS; hosted Notion MCP remains independently verified. A controlled test on one **new disposable child page** under that project executed REST create → read-back → `PATCH in_trash:true` with **all PASS and cleanup confirmed**. The page contents, token and account identifiers were not recorded in test outputs.
- **Release boundary:** the Windows Control Center source and isolated preview are qualified as a feature candidate, **not promoted over the currently installed Control Center**. Native Linux Control Center remains a separate read-only monitor by its current contract; the core PAT CLI is cross-platform, but Linux GUI enrollment and general-public release must be separately reviewed and qualified. Installer and release tests for the new dashboard are required before changing production installers.
