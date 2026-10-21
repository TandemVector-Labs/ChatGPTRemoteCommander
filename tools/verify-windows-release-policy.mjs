import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function assertExactReleaseVersionTag(version,tag) {
  // Require a full match: JavaScript $ alone accepts trailing newline.
  const match=typeof version==='string' && /^[0-9]+(?:\.[0-9]+){2}/.exec(version);
  if (!match || match[0]!==version || tag!=='v'+version)
    throw new Error('WINDOWS_RELEASE_TAG_VERSION_MISMATCH');
}

export function evaluateWindowsRelease({signed,version,tag,policy,releaseNotes}) {
  assertExactReleaseVersionTag(version,tag);
  if (signed === 'true') return {mode:'AUTHENTICODE_SIGNED',allowed:true};
  if (signed !== 'false') throw new Error('WINDOWS_RELEASE_SIGNATURE_STATUS_UNVERIFIED');
  if (policy?.schema !== 'commander-unsigned-windows-release-v1' ||
      policy.version !== '0.10.24' || policy.tag !== 'v0.10.24' ||
      policy.version !== version || policy.tag !== tag ||
      policy.allowUnsignedWithGitHubAttestation !== true ||
      policy.scope !== 'only-this-version' ||
      policy.publishedInstallerSignature !== 'NotSigned' ||
      !policy.riskAcknowledgement?.includes('SmartScreen') ||
      !policy.riskAcknowledgement?.includes('do not replace Authenticode') ||
      !policy.verification?.includes('GitHub Sigstore'))
    throw new Error('WINDOWS_UNSIGNED_RELEASE_NOT_AUTHORIZED');
  if (!releaseNotes.includes('Windows installer: UNSIGNED') ||
      !releaseNotes.includes('SmartScreen') ||
      !releaseNotes.includes('GitHub attestation'))
    throw new Error('WINDOWS_UNSIGNED_RELEASE_RISK_NOTICE_MISSING');
  return {mode:'UNSIGNED_WITH_REQUIRED_SIGSTORE_PROVENANCE',allowed:true};
}

const ownScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (ownScript) {
  try {
    const version=process.env.RELEASE_VERSION??'';
    const tag=process.env.RELEASE_TAG??'';
    const signed=process.env.SETUP_SIGNED??'';
    // Reject untrusted release names before filesystem reads.
    assertExactReleaseVersionTag(version,tag);
    // The exception for unsigned installers is version-scoped. The reviewed
    // policy already admits only 0.10.24; use a literal file URL rather than
    // constructing an OS path from untrusted release metadata.
    let policy;
    let releaseNotes='';
    if (signed === 'false') {
      if (version !== '0.10.24' || tag !== 'v0.10.24')
        throw new Error('WINDOWS_UNSIGNED_RELEASE_NOT_AUTHORIZED');
      policy=JSON.parse(readFileSync(new URL('../docs/UNSIGNED_WINDOWS_RELEASE_POLICY.json',import.meta.url),'utf8'));
      releaseNotes=readFileSync(new URL('../docs/RELEASE_0.10.24.md',import.meta.url),'utf8');
    }
    const decision=evaluateWindowsRelease({signed,version,tag,policy,releaseNotes});
    console.log('WINDOWS_RELEASE_DISTRIBUTION_POLICY_PASS mode='+decision.mode+' tag='+tag);
  } catch (e) {
    console.error('WINDOWS_RELEASE_DISTRIBUTION_POLICY_DENIED: '+e.message);
    process.exitCode=1;
  }
}
