import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json','utf8'));
const builder = readFileSync('tools/build-release-assets.sh','utf8');
const workflow = readFileSync('.github/workflows/release-sync.yml','utf8');
const browserFetcher = readFileSync('scripts/fetch-browser-setup.ps1','utf8');
const innoFetcher = readFileSync('scripts/install-inno-setup.ps1','utf8');
const browserVersion = '0.8.1';
const browserSha256 = 'dcf4c5bc5d0ca8788f803e469246512af3745c81f578411dbabf6ce2a97feca2';
if (!/^[0-9a-f]{64}$/.test(browserSha256)) throw new Error('Browser release SHA pin must be concrete');

for (const required of [
  'plugin-template.zip',
  'plugin-template-v$VERSION.zip',
  'ChatGPT-Remote-Commander-v$VERSION-Installer.zip',
  'ChatGPT-Remote-Commander-Windows-Setup-v$VERSION.zip',
  'ChatGPT-Remote-Commander-Windows-Setup.zip',
  'ChatGPT-Remote-Commander-Linux-Setup-v$VERSION.zip',
  'ChatGPT-Remote-Commander-Linux-Setup.zip',
  'setup-wizard.ps1',
  'setup-wizard.sh',
  'build-device-plugin.ps1',
  'build-device-plugin.sh',
  'tools/generate-device-plugin.mjs',
  'server-install-windows.ps1',
  'server-install-linux.sh',
  'SHA256SUMS.txt',
  'SHA256SUMS-INSTALLER.txt',
  'zip_tree',
  'sha256sum -c SHA256SUMS.txt',
  'count="$('
]) {
  if (!builder.includes(required)) throw new Error(`release asset builder missing ${required}`);
}
if (!builder.includes('[[ "$count" -eq 19 ]]')) throw new Error('release asset count guard missing');
if (!builder.includes('Release commit: $COMMIT')) throw new Error('installer bundle provenance missing');

for (const required of [
  'actions/setup-dotnet@26b0ec14cb23fa6904739307f278c14f94c95bf1',
  './scripts/install-inno-setup.ps1',
  './scripts/fetch-browser-setup.ps1',
  "-Version '0.8.1'",
  "-Sha256 'dcf4c5bc5d0ca8788f803e469246512af3745c81f578411dbabf6ce2a97feca2'",
  '-BrowserInstaller $browser',
  '.\\installer\\build-setup.ps1',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
  "if: github.event_name != 'pull_request'",
  'Remote-Commander-Setup-v${version}.exe',
  'bash tools/build-release-assets.sh dist/release',
  'sha256sum -c SHA256SUMS.txt',
  'mapfile -t assets',
  'test "${#assets[@]}" -eq 20',
  'gh release create "$tag" "${assets[@]}"',
  '--verify-tag'
]) {
  if (!workflow.includes(required)) throw new Error(`release workflow missing ${required}`);
}
if (workflow.includes('gh release upload')) throw new Error('immutable release workflow must attach assets at create time, not after publication');
// R499: v0.10.23 may be tagged and attested, but never silently become
// latest Stable while owner endpoints have autoUpdate.enabled=true and the
// Saeid host is unreachable. Preserve atomic full-asset draft creation.
if (!(workflow.includes('gh release create "$tag" "${assets[@]}"') &&
      workflow.includes('--notes-file "$notes"') &&
      workflow.includes('            --draft')) ||
    !workflow.includes('RELEASE_SYNC_DRAFT_STAGED tag=$tag') ||
    workflow.includes('RELEASE_SYNC_PUBLISHED tag=$tag assets='))
  throw new Error('R499_RELEASE_MUST_REMAIN_DRAFT_PENDING_FLEET_ACCEPTANCE');

if (workflow.includes('choco install innosetup')) throw new Error('release workflow must not depend on mutable Chocolatey Inno acquisition');
if (!browserFetcher.includes('releases/download/v$Version/$Name')) throw new Error('Browser fetcher must use immutable versioned release URL');
if (!browserFetcher.includes('Get-FileHash') || !browserFetcher.includes('Browser SHA256 mismatch')) throw new Error('Browser dependency hash verification missing');
if (!innoFetcher.includes('9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732')) throw new Error('Inno Setup compiler hash pin missing');
if (!workflow.includes(browserVersion) || !workflow.includes(browserSha256)) throw new Error('Browser release pin missing from workflow');
if (!workflow.includes('docs/RELEASE_${version}.md')) throw new Error('release notes must follow package version');
if (pkg.version !== '0.10.23') throw new Error(`unexpected package version ${pkg.version}`);

// R171: Provenance must fail closed before an immutable release can be published.
for (const marker of [
  'id-token: write',
  'attestations: write',
  'actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6',
  "subject-path: 'dist/release/*'",
  'R171_IMMUTABLE_TAG_AND_ASSETS_PREATTEST_PASS',
  'git cat-file -t',
  'refs/tags/$tag^{commit}',
  'test "$count" -eq 20'
]) if (!workflow.includes(marker)) throw new Error('R171_ATTESTATION_CONTRACT_MISSING ' + marker);
const a=workflow.indexOf('id: release_identity');
const b=workflow.indexOf('name: Attest immutable release assets');
const c=workflow.indexOf('name: Publish matching qualified tag with assets');
if (!(a>0 && b>a && c>b)) throw new Error('R171_ATTESTATION_ORDER_REJECT');
const releaseOnly=workflow.slice(workflow.indexOf('  publish:'),c);
if (!releaseOnly.includes('contents: write') || !releaseOnly.includes('id-token: write') || !releaseOnly.includes('attestations: write')) throw new Error('R171_PUBLISH_PERMISSIONS_REJECT');
const buildSection=workflow.slice(workflow.indexOf('  build-windows-setup:'),workflow.indexOf('  publish:'));
if (buildSection.includes('id-token: write') || buildSection.includes('attestations: write')) throw new Error('R171_BUILD_PERMISSIONS_WIDENED');
if (!workflow.includes("if: ${{ steps.release_identity.outputs.accepted == 'true' }}")) throw new Error('R171_TAG_GUARD_MISSING');
console.log('R171_ATTESTATION_CONTRACT_PASS');

console.log('RELEASE_ASSET_CONTRACT_PASS');

// R11: unsigned Windows distribution requires exact version opt-in, source provenance
// and release notes. Authenticode status remains visible; no false signing claims.
for (const m of [
 'id: verify_installer_signature',
 'Get-AuthenticodeSignature -LiteralPath $setup',
 "signature.Status -eq 'Valid'",
 'installer_signed: ${{ steps.verify_installer_signature.outputs.signed }}',
 'Authorize Windows distribution mode for this exact version',
 'tools/verify-windows-release-policy.mjs',
 'Verify GitHub provenance of final installer before release',
 'gh attestation verify "$artifact" --repo "$GH_REPO"',
 '--source-ref "refs/tags/$tag"',
 '--source-digest "$commit"',
 '--signer-workflow "$GH_REPO/.github/workflows/release-sync.yml"',
 'WINDOWS_RELEASE_GITHUB_PROVENANCE_VERIFIED'
]) if (!workflow.includes(m)) throw new Error('UNSIGNED_ATTESTED_RELEASE_GUARD_MISSING ' + m);
const releaseIdentityAt=workflow.indexOf('id: release_identity');
const policyAt=workflow.indexOf('name: Authorize Windows distribution mode');
const attestAt=workflow.indexOf('name: Attest immutable release assets');
const verifyAt=workflow.indexOf('name: Verify GitHub provenance of final installer');
const publishAt=workflow.indexOf('name: Publish matching qualified tag with assets');
if (!(releaseIdentityAt>0 && policyAt>releaseIdentityAt && attestAt>policyAt &&
 verifyAt>attestAt && publishAt>verifyAt)) throw new Error('UNSIGNED_ATTESTED_RELEASE_ORDER_REJECT');
if (workflow.includes('name: Block unsigned setup before production release'))
 throw new Error('LEGACY_UNSATISFIABLE_SIGNATURE_GATE_PRESENT');
if (!workflow.includes('docs/UNSIGNED_WINDOWS_RELEASE_POLICY.*') ||
 !workflow.includes('docs/RELEASE_0.10.23.md') ||
 !workflow.includes('test/unsigned-windows-release-policy.test.mjs'))
 throw new Error('UNSIGNED_RELEASE_POLICY_TRIGGER_MISSING');
console.log('R11_SCOPED_UNSIGNED_ATTESTED_RELEASE_GUARD_PASS');
