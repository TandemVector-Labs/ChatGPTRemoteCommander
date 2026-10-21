# Native Notion Engine — scoped prototype (2026-10-21)

## Purpose and status
Implements a **Commander Core-owned**, opt-in Notion REST client and OAuth connection, not a second workflow engine. Code lives in `src/notion-engine.mjs` and is integrated into `src/server-v0.3.mjs`. It is a **development candidate** in `feat/native-notion-engine-20261021`; **not installed, signed, released or connected to a real Notion Workspace**. Notion MCP remote-client support, dashboard, webhooks and two-way sync remain separate later integration gates.

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
- Notion MCP client over Streamable HTTP and OAuth PKCE/DCR is a **future integration**, not implemented by this REST prototype. Notion itself remains a hosted service.
- Do not enable this experimental code in live production until exact-host, provider and cross-platform acceptance are evidenced.

## Tests
`node --check src/notion-engine.mjs`
`node --test test/notion-engine.test.mjs test/notion-core-http.test.mjs`

Tests use a synthetic memory vault and mocked Notion API; they do **not** establish real-account authorization. A Windows DPAPI round-trip test uses only fixture data and cleans its temporary directory. For full acceptance: live consent, read, explicitly authorized disposable-page create, restart/refresh, account isolation, Linux libsecret availability, invalid callback, rate-limit and failure recovery, host restart, and integration qualification on current product SHA.

- https://developers.notion.com/reference/get-block-children

## Official sources
- https://developers.notion.com/guides/get-started/authorization
- https://developers.notion.com/reference/create-a-token
- https://developers.notion.com/reference/refresh-a-token
- https://developers.notion.com/reference/request-limits
- https://developers.notion.com/guides/mcp/build-mcp-client

## Verification evidence — 2026-10-21

- Windows full check: operation 63debde8-b1ed-4727-909b-170deb6435e8 TIMED_OUT after 120 seconds while running the qualification wrapper (no failure shown in captured test segment). This is NOT a full-suite PASS; the hosted CI rerun remains the acceptance gate.
- GitHub Draft PR #54 first CI attempt exposed a pre-existing HTTP fixture isolation constraint: server-v0.3.mjs had eagerly imported the new Notion module even when Notion was disabled, while test/agent-extensions-http.test.mjs copied a deliberately minimal server fixture without that optional module. The root fix switches Notion to config-gated dynamic import in the server, without changing those fixtures. Windows regression on agent-extensions-http, http-admission, Notion unit and Notion HTTP: 15/15 PASS. Full CI must be re-run on a new commit before integration.


- Latest Windows selective qualification: 62/62 targeted tests PASS (Notion OAuth, authenticated call mocks, page-block pagination, native MCP exposure, legacy MCP contract, schema continuity, extension routing, and workflow roadmap). Exact command: `node --test test/notion-engine.test.mjs test/notion-core-http.test.mjs test/mcp-conformance.test.mjs test/schema-continuity-gate.test.mjs test/agent-extensions.test.mjs test/workflow-owner-roadmap.test.mjs`. `node --check` and `git diff --check` PASS on the same checkout.
- Linux aliemad-Labtop (Node 22) executed the updated Notion unit suite from an isolated private `/tmp` staging directory. The Windows-to-Linux code and test SHA-256 matched: 11 passed, 1 Windows-only DPAPI test skipped, 0 failed. This is a portable unit test, **not** real Linux keyring login or integrated MCP server testing.
- Tested OAuth state matching, one-live-session reentrancy, denied-consent listener teardown, token refresh/rotation, HTTPS redirect refusal, controlled 429/529 retries, no premature Retry-After override, disabled mutations, Windows DPAPI synthetic-token round trip, block cursor validation and truncation signals.
- Current account cannot be authenticated into Commander without an independently registered Notion public connection's client ID, protected secret and owner-approved pages; the ChatGPT Notion connector does not supply Commander credentials. Live OAuth consent, real workspace read/write, MCP-to-Notion remote client, and production host rollout remain **OPEN**.
