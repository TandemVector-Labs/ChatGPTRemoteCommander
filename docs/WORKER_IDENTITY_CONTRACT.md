# V1-07 Commander Worker Identity Contract

## Status and scope

This is a source-integrated V1-01/V1-07 candidate contract, authority module, native tunnel-attestor adapter, and WorkflowStore-backed durable registry with regression tests. The integration is on feature/v1-01-worker-grants-20261108 and has not yet been merged into the V1-00 integration branch. It does not enroll a production host, generate or persist a production private key, read tunnel credentials, change a tunnel profile, install a runtime, or authorize production execution by itself.

The stable Commander worker identity introduced here is distinct from the existing Project Engine run-scoped `workerId`. Integration must preserve the latter and map this persistent identity explicitly.

## Identity model

A worker registration is bound to:

- `hostId` and `profileId`, supplied by trusted bootstrap rather than an MCP/model request;
- `ownerSidHash`, the SHA-256 digest of the OS owner SID/UID observed by a native attestor;
- `deviceProvider` and `deviceIdHash`, supplied by a trusted device attestor (`tailscale` or `native-key-store`);
- `keyId`, SHA-256 of the worker Ed25519 SPKI public key;
- `grantRevision`, the positive monotonic revision of the exact V1-01 per-worker grant, included in the signed registration claims;
- `tunnelProvider`, `tunnelIdHash`, and current poll/health evidence from a trusted tunnel adapter;
- V1-01 owner context: `principalId`, `conversationId`, and `bindingId`;
- V1-01 `capabilityPolicyDigest`.

`workerId` is deterministic from the host, profile, OS-owner hash, device provider/hash, and Ed25519 key ID. It does not depend on the chat, owner-binding epoch, tunnel ID, or tunnel process instance. A regrant can therefore retain the same stable worker while creating a new signed registration under a new `bindingId`.

The tunnel ID is transport context, not device identity. The OpenAI tunnel client creates a new opaque `client_instance_id` per process for request correlation; it must not be used as a stable worker ID. Only a hash of the tunnel ID is stored. No runtime API key or raw tunnel ID is accepted by this module.

## Trust boundaries

All following functions are mandatory trusted bootstrap dependencies; none may be sourced from model output, tool arguments, a public HTTP body, or an untrusted project file:

- `resolveOwnerContext()`: must return the current native owner-attested route and V1-01 `bindingId`;
- `resolveOwnerGrant(identity)`: must resolve the owner grant from the native grant registry and bind the exact worker key, device, tunnel, owner route, and policy digest;
- `authorizeExactInvocation(route, {tool, arguments})`: V1-01 exact-invocation authority, called for registration, every worker action, and revocation;
- `resolveDeviceIdentity()`: must prove the device identity and OS owner via Tailscale or an OS-protected native key provider;
- `resolveTransportIdentity()`: must prove the exact tunnel profile, OS owner, successful control-plane poll, and fresh health/readiness;
- `resolveCapabilityPolicyDigest()`: must return the current digest from the canonical V1-01 capability policy;
- `registry`: must be a durable, machine-global, atomic registry.

The owner-grant projection includes the V1-01 bindingId, worker/key IDs, host/profile/principal/conversation, owner SID hash, device/tunnel hashes, policy digest, a positive monotonic revision, issued/expiry times, and an explicit status (ACTIVE or REVOKED). The authority rejects a missing/invalid revision or any status other than ACTIVE, and compares the full grant again after asynchronous owner authorization. The current V1-01 candidate exposes a read-only native owner-context/route projection and a V2GrantRegistry worker-grant adapter. The adapter composes the same registry instance used by V101ProtectedRouterBridge, checks the exact worker grant/revision, and delegates base route/tool and exact-argument authorization to the existing native bridge. It does not invent or replace the owner authority.

## Durable registry contract

Production registry methods:

- `get(workerId)` returns the current public registration envelope or null;
- `register(envelope, { expectedPreviousBindingId, expectedPreviousState })` performs an atomic compare-and-swap for `EMPTY`, `REVOKED`, or `EXPIRED` state;
- `isRevoked(workerId, bindingId)` checks revocation for the exact owner-binding epoch;
- `revoke(workerId, bindingId, receipt, { expectedSignature })` atomically revokes the exact registration.

Implemented in src/workflow-store.mjs and src/worker-identity-store.mjs: the registry uses the existing machine-global root-leases.sqlite database, alongside root_leases, rather than creating a second database. worker_identity_events is an append-only hash-chained journal with update/delete triggers; worker_identity_registry is a checked projection. Registration and revocation use BEGIN IMMEDIATE, exact compare-and-swap, public-envelope signature/key/worker-ID verification, and post-write journal/projection readback. Journal integrity and projection consistency are checked on reads and mutations. The registry stores only the signed public envelope; the private key is never passed to or stored by WorkflowStore. The in-memory test registry remains useful only for isolated authority-unit tests. An active registration cannot be silently replaced; re-enrollment after revocation/expiry requires a different owner `bindingId`. The V1-00 candidate now contains this durable adapter and its cross-process/restart tests; the feature branch has not yet been merged into the canonical integration branch.

## Authorization behavior

1. The worker private key is supplied as an Ed25519 `KeyObject` from a native key store; this module never writes or exports it.
2. The public key fingerprint determines `keyId`; the stable identity tuple determines `workerId`.
3. Registration requires an active native owner context, current owner-grant projection, fresh device attestation, fresh tunnel poll/health, and current policy digest. The Ed25519-signed registration binds the exact positive `grantRevision`; a later revision mismatch fails closed and requires a new owner-binding epoch before re-enrollment.
4. Registration itself requires exact V1-01 authorization for `worker.register`.
5. Every action reloads the registration, verifies its Ed25519 signature, checks expiry and exact host/profile/chat/binding/device/tunnel/policy scope, re-resolves the owner grant, and calls V1-01 exact-invocation authorization.
6. Trust is rechecked after asynchronous authorization to fail closed on a binding, grant, device, tunnel, or policy change.
7. Revocation requires exact V1-01 authorization for `worker.revoke`, then a durable binding-specific registry write and readback.
8. A revoked or expired registration never authorizes execution.

## Previously observed transport evidence and limitations (not revalidated in this candidate)

The earlier host audit recorded five Windows hosts and 12 observed tunnel-client processes/profiles in total. These observations were not revalidated during the present source-only candidate work. Exact-PID `tunnel-client health --require-control-plane-poll --json` checks returned health/readiness 200 and a successful control-plane poll for the 12 profiles. The local `/health/control-plane` route is available on 10 profiles; it returns 404 on the two profiles running the older v0.0.14 client. That route is diagnostic health, not a device identity assertion. The supported CLI poll result remains the transport health signal for those older profiles.

Tailscale CLI identity is available on Aliemad-Labtop, Emad-PC-Ultimate, and Emad-PC-Lite. On Windows hosts without Tailscale CLI, the tunnel client provides transport identity/health only; the stable device identity must come from the native OS-protected key provider. The process-scoped tunnel `client_instance_id` is not a substitute.

The local shell did not have the runtime API key required by `tunnel-client admin tunnels get`. No runtime or admin key was read, exported, or reused. The local health endpoint does not expose a signed device-registration assertion. Therefore the live tunnel evidence does not yet constitute worker enrollment.


## Native tunnel attestor adapter — isolated source implementation

src/native-tunnel-attestor.mjs is a dependency-injected resolveTransportIdentity adapter for the V1-07 authority. It does not invoke a shell, run tunnel-client, read environment variables, or access runtime/admin API keys. The trusted host bootstrap must supply:

- resolveOwnerSidHash(): a native OS-owner hash, not a username or profile label;
- resolveOwnedTunnelProcess(): exactly one live process, with the pinned executable path/hash, exact profile argument, PID, start time and owner hash;
- probeTunnelHealth(process): an exact-PID/profile probe proving authenticated control-plane polling and both health/readiness status 200.

The adapter rejects ambiguous profile matches, PID reuse/process replacement, owner changes during the probe, executable drift, stale/future polls, missing authentication, and any unexpected health fields (including credential-shaped extras). It re-resolves the owner and process after the asynchronous health probe. The opaque clientInstanceId contributes only to a domain-separated tunnelIdHash; it is not returned and is never used as stable workerId or device identity. A process restart therefore changes transport context and requires fresh trust evaluation.

The host adapter is still a required external integration. The current Commander program allowlist refused direct invocation of the tunnel-client binary, so this source adapter has not performed a live poll or established production tunnel attestation. Do not route around the allowlist. Synthetic tests qualify the adapter contract only.



## Cross-workstream dependencies

- V1-01: the candidate now includes a Linux native owner-session provider, visible default-deny owner/admin authorizer, one-shot OpenAI-session proof capability, OAuth preflight/owner-binding admission path, and async grant-registry approval callbacks. These are source-integrated only. The host must still wire a real OpenAI ChatGPT mTLS session attestor, current OAuth verifier/principal route, and the actual interactive owner session; no approval prompt was run in this qualification.
- V1-00: the candidate adds the signed public worker registry to the existing machine-global root-leases.sqlite through WorkflowStore, with append-only hash-chained events, projection verification, read/write transactions and cross-process CAS. It is not yet merged into the canonical integration branch.
- V1-06: the `integration/v012-core-20261108` candidate propagates the signed worker tuple (`workerId`, `workerKeyId`, exact `workerGrantRevision`) from the original execution receipt through the durable delivery item into presentation protocol v2. Legacy pre-identity rows remain isolated on protocol v1; v1 cannot ACK a worker-bound v2 result. Every v2 ACK requires the Host-only `assertWorkerIdentityCurrent` callback. The same candidate now derives and persists `workflowScope` from the active root lease and passes the frozen scope to Host dispatch; the scope is not yet included in the signed original execution receipt. Source-only; no production callback or issuer is wired.
- V1-08: package, install, and rollback the integrated adapters only after source qualification and native-provider acceptance.
- Platform source adapters are now present: Linux systemd credential loading, Windows DPAPI CurrentUser seed loading and SID hashing, a fixed-argument native process probe, and a Tailscale device attestor. They are not yet wired to a production host bootstrap; TPM-backed key storage, live Linux systemd credential service, live Windows DPAPI/TPM owner proof, and an allowlisted live Tailscale probe remain unqualified.

## Source QA

Run:

    npm run test:v1-01-worker-grants
    npm run test:v1-07-worker-identity
    npm run test:workflows
    npm run audit
    npm run check

The focused tests use ephemeral Ed25519 keys, synthetic owner/device/tunnel attestations, temporary SQLite databases and isolated Node processes. Source-test PASS is not production owner consent, native key-store attestation, live tunnel health, installation, or release acceptance.

## V1-01/V1-07 integrated source candidate (2026-11-08)

- Candidate branch/worktree: feature/v1-01-worker-grants-20261108, /home/aliemad/.cache/rc-v101-worker-grants-20261108, based on the canonical V1-00 integration commit e2f5974. The separate integration/v012-core-20261108 worktree contains other staged/untracked work and was not modified.
- V101ProtectedRouterBridge now exposes read-only resolveOwnerContext(token) and resolveOwnerRoute(token) projections from the internal native owner binding. These expose the owner bindingId, current route and bounded expiry, but not the bearer, token digest or native session handle. Both projections fail closed after binding revocation or bridge shutdown.
- V2GrantRegistry schema v3 adds worker enrollment and exact per-task grants to the existing host-scoped v2-access.sqlite. Enrollment is bound to worker/key/owner-SID/device/tunnel/policy/binding identity, uses bounded expiry and expected-revision CAS, and requires a trusted owner-administration callback. Task grants bind the exact conversation, operation ID, target, tool and worker epoch. Worker enrollment/tool event tables are append-only.
- createV101WorkerIdentityGrantAdapter composes the V1-07 authority with the exact same V2GrantRegistry instance used by the native bridge. It checks grantRevision, owner binding, worker/key/device/tunnel/policy tuple and exact route/task/tool grant before and after asynchronous native bridge authorization. The bridge also accepts the dotted control-plane tool names worker.register and worker.revoke under the bounded tool-name grammar.
- WorkflowStore now stores the signed public worker registration in the existing machine-global root-leases.sqlite; it does not create a second identity database and never receives a private key. The adapter verifies Ed25519 signatures, key-derived worker IDs, bounded claims, CAS state, append-only hash-chain journal and projection consistency. Read operations use a SQLite read transaction; registration/revocation use BEGIN IMMEDIATE.
- native-tunnel-attestor.mjs supplies the dependency-injected transport projection and rejects ambiguous/stale/replaced/unowned process evidence. It does not invoke the tunnel CLI, access credentials, or claim a live poll.
- The cross-layer integration test uses the real V1-01 native bridge, V2GrantRegistry, V1-07 authority, WorkflowStore-backed registry and synthetic attestors. It proves registration, signed grantRevision, exact tool authorization, durable readback, revocation, wrong-target denial, task-grant denial and owner-binding rotation denial.
- Production blockers remain: native device-key/owner-SID attestation, real owner/admin approval for grant issuance/revocation, live authenticated tunnel provider, actual host bootstrap wiring, V1-06 live `assertWorkerIdentityCurrent` provider and paired-host ACK, Host-signed binding of `workflowScope` into the original execution receipt, V1-05 process-containment/proof-based reconciliation integration, and V1-08 packaging/install/rollback. No production worker was enrolled and no runtime key was accessed.
- release-train-0.12.json acceptance flags remain false. Source QA does not satisfy G1/J01, release, or production enrollment.


## 2026-11-08 V1-01 native owner-context projection hardening

The V1-01 source candidate now requires the native session-binding provider to expose resolveNativeOwnerContext(sessionHandle) independently of the token-to-session lookup. The projection contains only the native host/profile/principal/conversation route, a fresh random 256-bit bindingId, the OS-derived ownerSidHash, and the native consent expiry. The provider re-reads the OS owner hash before and after consent and on every route/context admission; owner or seat drift invalidates the binding. The trusted ingress compares both independent projections before issuing a ticket and revalidates them after asynchronous boundaries.

The Linux isolated source candidate passed 143/143 focused V1-01/V1-07 tests and the all-ref security audit over 33,431,568 history bytes. The integrated NoPromote worktree must repeat the focused and full qualification after this selective merge.

Still not production acceptance: the Linux native owner/session and administration providers are source-integrated but have not been activated against a real interactive owner seat; no current-chat owner consent was granted, and the owner-visible prompt was deliberately not reissued. The Windows native owner-session/consent path is not implemented here. The Linux systemd and Windows DPAPI key providers are source-level only; no production worker key is enrolled, no live tunnel identity has been attested, and no trusted Host callback/issuer is wired. Do not enroll workers or enable executionAccess/receiptAuthority until those providers are independently qualified.


## 2026-11-08 V1-06 worker-bound delivery receipt integration (NoPromote)

The 0.12 integration candidate now binds the V1-07 worker identity into the delivery trust chain:

- The original execution receipt must carry `workerId`, `workerKeyId`, and `workerGrantRevision` under the Host signature.
- `DeliveryStore` rejects an origin receipt hash without a valid worker tuple, and rejects a worker tuple without an origin receipt hash.
- The authenticated ACK path passes that exact tuple into signed presentation protocol v2. The v2 domain and schema are signed; a v1 legacy proof cannot be reinterpreted as a worker-bound proof.
- V2 ACK now fails closed unless the owner Host supplies `assertWorkerIdentityCurrent`. The callback must verify the exact durable worker registration, key ID, owner binding, current grant revision, expiry and revocation against the V1-07 registry. The callback is an identity-current check only; it does not authorize execution or replace the V1-01 owner grant.
- The Host runtime composition helper rejects missing callback wiring. The standalone verifier still permits protocol v1 for pre-identity legacy rows; those rows do not invoke the worker callback.

The 0.12 integration worktree now derives a frozen `workflowScope` from the same active root-lease/step admission: `workflowId`, `stepId`, `operationId`, `rootFingerprint`, workflow `revision`, deterministic `leaseId`, and `fencingToken`. It persists the scope in the workflow step and durable receipt, returns it in operation metadata, passes it as the fourth internal Host-dispatch argument, and revalidates the fingerprint and lease ID against the live lease row before and after dispatch. The root-lease SQLite table still has no dedicated `lease_id` or `root_fingerprint` columns; the values are deterministic hashes and are persisted in the append-only workflow record.

This does not yet make the scope a signed execution receipt: V1-06's original Host receipt/presentation claims still bind the worker tuple only, and the production Host issuer does not consume `ctx.workflowOperation`. The separate V1-05 worktree contains a broader process-containment/proof-based reconciliation implementation, but it remains dirty and unintegrated; selective integration is required, excluding duplicate V1-01/V1-07 worker-identity code. Do not substitute an operation ID for a lease ID or a raw project path for a fingerprint.

This is a source-only NoPromote candidate. It does not establish a production worker key, native owner/session provider, authenticated tunnel provider, Host callback, J01 consent, originating-chat presentation, installed ACK or fleet acceptance.


## 2026-11-09 V1-01 Linux native owner/session and platform-session admission (NoPromote)

The 0.12 integration candidate now selectively includes the latest V1-01 owner-admission source delta, while preserving the pre-existing V1-00 installer and installer/update changes:

- native-owner-session-provider-linux.mjs derives the owner hash from the current process UID and user namespace, checks the exact active local logind seat/session, and uses pinned root-owned /usr/bin/loginctl and /usr/bin/zenity executables with execFile (no shell). The owner-binding dialog defaults to Deny, verifies the owner/session before and after the visible decision, and grants no OS elevation.
- native-owner-administration-authorizer.mjs binds worker enrollment, per-task grants and revocation to the exact native owner context and route. V2GrantRegistry administration mutations now await the trusted approval callback before their durable CAS/event write.
- v2-platform-session-proof.mjs provides an in-process, one-shot capability bound to the ChatGPT mTLS peer, openai/session handle and bearer digest. The V2 HTTPS ingress carries that capability to v101-v2-protected-dispatcher.mjs, which preflights OAuth, validates the exact session/route and then requires native owner binding before protected calls.
- v101-linux-owner-security-bootstrap.mjs composes the Linux owner provider, owner-administration authorizer, V2 grant registry, platform-session proof authority and candidate direct HTTPS gateway. It opens no listener, performs no enrollment, and does not create an elevated process.
- The existing V2 native owner-session binding now rechecks token-digest uniqueness after asynchronous consent, preventing two concurrent owner dialogs from binding the same bearer to different sessions.

### Candidate source QA receipts

- V1-01 focused suite: 244/244 PASS (operation 10a44d9c-ba79-47d2-b519-e6572331c6f7).
- V1-07 focused suite, including the native process/Tailscale/Linux systemd/Windows DPAPI source tests: 67/67 PASS (operation 4ba586be-1b8a-4f2f-a945-50935d06118c).
- Workflow suite after both integrations: 584/584 PASS (operation c83d3eb0-117e-4c7e-8436-91f081b8f794).
- V1-06 signed-origin tests: 69/69 PASS (operation c275c933-1016-431b-a6a5-16c98af31f5c); delivery/ACK tests: 292/292 PASS (operation 847ad6ff-6594-4aaf-a2c2-4b592fd6df69).
- Full check:qualification: exit 0 (operation f83b160d-385c-48d9-ae49-b50a51864fa3); full test:qualification: exit 0 (operation b9ba58e2-7571-4774-9021-ba356f1d4c79).
- All-ref security audit: SECURITY_AUDIT_PASS, 34,634,561 Git-history bytes (operation 29195c92-40fd-4d18-9aa6-6a41347706e9); git diff --check PASS.

These are source/test receipts only. No real OpenAI mTLS current-chat attestation, production OAuth issuer/verifier, owner consent, Linux systemd credential mount, Windows DPAPI/TPM host probe, live Tailscale CLI probe, Host issuer/registry callback, worker enrollment, signed ACK, cross-host transfer, install, canary or rollback was exercised. The candidate remains NoPromote; the existing staged Windows installer and all unrelated dirty files remain preserved.
