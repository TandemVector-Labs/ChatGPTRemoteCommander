import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function evaluateWindowsRelease({signed,version,tag,policy,releaseNotes}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)||tag!==`v${version}`)
    throw new Error('WINDOWS_RELEASE_TAG_VERSION_MISMATCH');
  if (signed === 'true') return {mode:'AUTHENTICODE_SIGNED',allowed:true};
  if (signed !== 'false') throw new Error('WINDOWS_RELEASE_SIGNATURE_STATUS_UNVERIFIED');
  if (policy?.schema !== 'commander-unsigned-windows-release-v1' ||
      !['0.10.24','0.10.25','0.10.26'].includes(version) ||
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
    if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('WINDOWS_RELEASE_VERSION_INVALID');
    const policyPath=['0.10.25','0.10.26'].includes(version)
      ? `docs/UNSIGNED_WINDOWS_RELEASE_POLICY_${version}.json`
      : 'docs/UNSIGNED_WINDOWS_RELEASE_POLICY.json';
    const policy=JSON.parse(readFileSync(policyPath,'utf8'));
    const releaseNotes=readFileSync(`docs/RELEASE_${version}.md`,'utf8');
    const decision=evaluateWindowsRelease({signed,version,tag,policy,releaseNotes});
    console.log('WINDOWS_RELEASE_DISTRIBUTION_POLICY_PASS mode='+decision.mode+' tag='+tag);
  } catch (e) {
    console.error('WINDOWS_RELEASE_DISTRIBUTION_POLICY_DENIED: '+e.message);
    process.exitCode=1;
  }
}
