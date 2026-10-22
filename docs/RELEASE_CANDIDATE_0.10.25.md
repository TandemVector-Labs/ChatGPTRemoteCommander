# Remote Commander 0.10.25 — SOURCE CANDIDATE ONLY

**NOT tagged, released, installed or approved for unsigned public distribution.**
Owner execution surface: ChatGPT + Remote Commander, not Work.

Parent reviewed and merged source: 99d3908e848eee01714eb8e2832b4f5eba5f8df1
(PR #238). Candidate changes only declared application/Plugin/desktop version
identity and release-admission tests; existing historical tags remain immutable.

Four native roadmap tools are included in source:
- workflow_roadmap: read the complete current ordered DAG, not an executed claim.
- workflow_plan_insert: add approved task before an untouched pending target.
- workflow_plan_prioritize: reorder independent unfinished steps without
  modifying dependencies or completed work.
- workflow_plan_edit: change only untouched pending step title.

## Release and signing boundaries

The historical v0.10.24 policy authorizes an **UNSIGNED Preview only for that
exact version**. It does NOT authorize unsigned v0.10.25. Existing install
defaults therefore remain v0.10.24. No v0.10.25 tag or public release may be
created by this candidate pipeline; publishing requires separate exact source
SHA, trusted signer or explicitly owner-reviewed version-specific admission,
and rollback verification. A local UntrustedRoot code-signing certificate is
NOT publisher-trusted even with a matching private key. Do not disable OS
security, sign with unknown roots as though trusted, or infer new owner approval.

## Qualification and isolated canary

Require source identity and policy regression tests, npm check/test/audit and
hosted Windows + Ubuntu CI. Run native MCP canary against the exact
source-approved commit on a disposable local port/config/profile; verify
tool registration and durable readback after restart without touching live
port, tunnel, browser, GUI latch or existing SQLite workflow. Preserve current
Core 0.10.24 installation and a byte-exact recovery artifact.

Source qualification and isolated canary do not activate an unattended model
runner, do not complete real 41-case independent model evaluation and do not
replace a verified installed product.
