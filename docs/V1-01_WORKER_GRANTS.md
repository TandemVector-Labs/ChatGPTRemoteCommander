# V1-01 worker enrollment and per-task grants

Status: isolated source candidate with V1-01/V1-07/WorkflowStore composition tests passing; not installed, not production-wired, and not accepted for rollout.

- Branch: `feature/v1-01-worker-grants-20261108`
- Worktree: `/home/aliemad/.cache/rc-v101-worker-grants-20261108`
- Base HEAD: `e2f5974b0c66d6d8b04f041db0ec8db9f1bc439a`
- All changes remain uncommitted and isolated.

## Storage and ownership

`V2GrantRegistry` schema version 3 adds worker grants to the existing host-scoped `v2-access.sqlite`; it does not create a second authorization database.

- `v2_worker_grants` stores the owner-approved worker enrollment grant keyed by host, principal, profile, conversation, and worker ID. Its identity tuple binds `keyId`, owner SID hash, device provider/hash, tunnel provider/hash, capability-policy digest, and owner `bindingId`.
- `v2_worker_tool_grants` adds an exact per-task allowlist keyed by host/principal/profile/conversation, operation ID, target kind/ID, tool, and worker ID. It repeats the identity tuple and binding epoch so a grant cannot silently migrate to another key, device, tunnel, policy, chat, root, task, or worker.
- `v2_worker_grant_events` and `v2_worker_tool_grant_events` retain append-only grant/revocation history. SQL triggers reject event UPDATE and DELETE.
- Enrollment and task-grant changes use `BEGIN IMMEDIATE`, expected-revision CAS, bounded expiry, and default-deny checks. Active enrollment cannot be replaced. Re-enrollment after revoke requires a new owner binding epoch.
- Schema v2 upgrades additively to v3 and preserves existing route grants. Schema v1 remains fail-closed pending its separately approved migration.

V1-07's signed worker identity envelope is stored separately through the existing machine-global `WorkflowStore` root-lease database. The `worker_identity_events` journal is append-only and hash-chained; the projection is verified on reads, writes, and restart. Only the signed public envelope is persisted; the Ed25519 private key is not stored by this registry. The current branch includes the WorkflowStore worker-identity methods and their tests.

## Owner context and exact authorization

`V101ProtectedRouterBridge` exposes read-only `resolveOwnerContext(token)` and `resolveOwnerRoute(token)` projections. They are derived from the authenticated caller and the independent native owner-token/session binding. The opaque `bindingId` is the consent epoch and rotates on revoke/regrant. The bearer, raw token, and token digest are not returned.

`V101WorkerIdentityGrantAdapter` composes that bridge with the V2 worker-grant registry and a trusted `resolveCurrentAccessToken` callback:

1. `resolveOwnerContext` re-reads the current token and native owner binding; `resolveOwnerGrant` returns a grant only for the exact current owner context and binding epoch.
2. `authorizeExactInvocation` requires the exact positive `grantRevision` supplied by the V1-07 authority. It verifies the current enrollment tuple and expiry, resolves the canonical owner-selected route, and checks the per-worker task grant.
3. It then calls `bridge.authorizeTool` for the exact tool and arguments. The bridge independently checks the base route grant and native owner binding, and rechecks them after asynchronous owner policy.
4. The adapter re-reads the owner context, route, and worker grant after the awaited bridge decision. A changed owner epoch, grant revision, route, target, or expiry fails closed.

The owner SID hash is supplied by the independently native-owner-attested token/session binding returned by `resolveAttestedTokenBinding`; the bridge requires a 64-character lowercase SHA-256 digest, rechecks it before ticket issuance and after asynchronous exact-tool authorization, and projects it through `resolveOwnerContext`. The V1-01 feature candidate's `V2NativeOwnerSessionBindings` now supplies this projection directly: its trusted platform-session attestor returns an exact `native-platform-session` record containing the session handle and SHA-256 digest of the same OAuth bearer; the short-lived store binds that digest to the native OS seat, owner SID, binding epoch and expiry, and `resolveAttestedTokenBinding(tokenSha256)` rechecks the live owner/route/seat before returning it. Raw bearer tokens are never stored. The V1-01 worker adapter requires exact equality between that native owner hash and the V1-07 device/tunnel worker context. The platform attestor, OS owner hash resolver and explicit bind/revoke consent callbacks remain trusted Host dependencies; they are not yet production-configured. Owner SID is never inferred from MCP headers, model arguments, profile names, OAuth subject or Tailscale identity. Device identity, authenticated tunnel identity and private-key storage remain separate trust providers.

`worker.register` and `worker.revoke` are separately grantable actions. Ordinary tools require an exact per-task grant for the canonical root and operation. The V1-07 authority signs `grantRevision` into the registration envelope and rechecks it after asynchronous authorization.

## Production wiring still required

The source composition is tested, but the production bootstrap is not wired:

- `createV101WorkerIdentityGrantAdapter` is not imported by `server-v0.3.mjs` or the installed server bootstrap.
- `v101-v2-protected-dispatcher.mjs` constructs the protected Router bridge, but does not construct or invoke the worker identity grant adapter/authority.
- `authorizeAdministration` must be a trusted synchronous native owner/session verifier. The tests use a QA callback; no real owner grant-issuance flow or owner confirmation UI is configured.
- The real OAuth issuer, `verifyAccessToken`, current-bearer provider, native token-to-owner binding (including the OS-owner `ownerSidHash`), and native session-binding provider must be configured by trusted Host bootstrap. The owner hash must come from the same independently authenticated native owner principal that issued the `bindingId`; the bridge now rejects bindings without it. None may be derived from MCP request headers/body or model-controlled arguments.
- V1-07 still needs native device/OS-owner attestation, authenticated tunnel attestation, and an approved OS-protected Ed25519 key store. The feasibility tests only validated encrypted-PKCS8 and Windows DPAPI primitives in memory; no production key was stored or enrolled.
- V1-02 executionAccess, V1-06 receiptAuthority/paired-host ACK and replay handling, V1-09 exact model profile, V1-08 immutable install/canary/rollback, installed-runtime E2E, and fleet acceptance remain open.

## Source QA

The canonical candidate gate is `npm run test:v1-01-worker-grants`. It runs syntax checks for the bridge, grant registry, adapter, worker authority/store, native tunnel attestor, WorkflowStore and their helper/test modules, then executes the worker-grant, owner-bound bridge, V1-01/V1-07 adapter, authority, durable identity registry, native tunnel-attestor and WorkflowStore suites.

- Current integrated candidate gate: **168/168 PASS**, 0 fail, 0 skip (operation `e4c83139-088b-4bcc-9d2d-22b9bf44bf4f`, stdout SHA-256 `5007227817bff25104a5934b9dd183ef341779665479f69fe7761bc4b6ecec99`).
- Full `npm run test:workflows`: **405/405 PASS**, 0 fail, 0 skip (operation `70f527b0-9757-49ac-b61b-9191a8f9e433`, stdout SHA-256 `f0c0fbdd9d2641d2119ed427e62c83eab1db64d5e47149b066a2caf54b5779e7`).
- `npm run audit`: `SECURITY_AUDIT_PASS`, 33,431,568 Git-history bytes (operation `f04e8b39-b37b-4320-b183-a91def9bb1e7`, stdout SHA-256 `32938b5f8bd00a81e4fd9474d668d51ff8b1f33431f718650c54a9602794b3bb`).
- Package JSON, source syntax and `git diff --check`: `V101_CURRENT_DIFF_SYNTAX_PASS` (operation `fdfc1dd8-2919-4706-bf34-9c0f1260b742`, stdout SHA-256 `57203721e1d686b72dfd2cfb736eae2cbda9558b8f9aa07222975d8622a62942`).
- Independent V1-07 `npm run test:workflows`: **398/398 PASS**, 0 fail, 0 skip (operation `3a31e9af-5f26-401d-ad91-eebc3676c2fa`, stdout SHA-256 `c0e4d98a81f7593c0c6f804d97574e1565374f272abca17be6676acf9486d440`); V1-07 `npm run check` exited 0 (operation `f0f5764e-d70d-4732-a45d-afff3d9656cc`, stdout SHA-256 `5ee9e3395acfd000fb4dd68176f82af1d8508ec11427cd51347874bc83324e94`).

These results qualify isolated source/test candidates only. They do not establish a real native owner-consent/authorization provider, persistent OS-protected key storage, authenticated production tunnel identity, production Host/bootstrap wiring, V1-02 executionAccess, V1-06 receiptAuthority, installed-runtime behavior, paired-host dispatch, or release acceptance. No worker was enrolled, no production key or credential was stored, and no install, service restart, commit, push, or promotion occurred.
