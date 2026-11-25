# Optional event relay — public Commander Core contract

Status: **source-only candidate, NoPromote**. This is a generic opt-in event transport, not a built-in scientific, article, personalization, Coucou, or other specialty extension.

Commander owns host tools, workflow scheduler, project state, approval and audit. An independently installed owner-approved adapter may observe an allowlisted subset of completed tool outcomes. It cannot request tool execution, override approvals, read project content, start a second workflow scheduler or write a second authoritative Brain.

## Configuration and boundary

The optional `config.local.json` field is:

```json
{
  "extensionEventRelay": {
    "enabled": true,
    "extensionId": "YOUR-INSTALLED-EXTENSION-ID",
    "adapterPath": "ABSOLUTE_LOCAL_PATH_TO_OWNER_APPROVED_MJS",
    "adapterSha256": "SHA256_OF_EXACT_INSTALLED_ADAPTER_SCRIPT"
  }
}
```

Disabled/missing means no subprocess and no event transmission. An enabled adapter must be a regular one-link `.mjs` file at an absolute local path with exact SHA-256. No network paths, symlinks or hardlinks. The hash is rechecked before each event. The adapter runs as a separate Node subprocess using Commander's currently executing Node binary, sanitized environment, neutral root directory, no shell and a bounded 2-second lifetime. Its OS token is still the current user: a SHA pin and process boundary are **not** a sandbox or publisher signature. Only install trusted, licensed and explicitly approved private source.

Payload (single newline-terminated JSON object over stdin):

```json
{
  "schemaVersion": 1,
  "kind": "tool_outcome",
  "extensionId": "YOUR-INSTALLED-EXTENSION-ID",
  "tool": "workflow_checkpoint",
  "failed": false,
  "sessionId": "opaque-random-uuid"
}
```

The `tool` field is chosen from a fixed allowlist of workflow/operation lifecycle IDs only. No arguments, results, error descriptions, file paths, project identifiers, account data or secrets are forwarded. Child exit code zero reports *local adapter process exit*, not UI display, command execution or authenticated ChatGPT delivery. Failures never change the primary tool result. Only one observer child may run at once.

Legacy `coucouBridge` config is not automatically migrated and is ignored by this candidate. Owners must explicitly install a separate adapter and re-enable it with a verified hash. Preserve the legacy source and accepted installations until isolated functional and negative-capability tests pass. Source qualification is distinct from release inclusion, owner opt-in installation and native application validation.

## Release acceptance

Check absence of specialty source/manifests/docs in the public source, all required fixture source lists and package scripts, Windows/Linux project tests, official release artifacts and absence-only Commander operation. Never include private adapters inside `dist/`, public Release assets or CI artifacts. Do not promote this candidate solely because focused source tests pass.
