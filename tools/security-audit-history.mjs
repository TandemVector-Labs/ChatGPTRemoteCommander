// Fail-closed historical audit provenance. A single known Notion fake-vault
// bearer assertion is not a credential. Do not widen this exception to an
// entire branch, file, token class, or unrelated commit.
const notionFixtureCommits=new Set([
  '7b28ae4ffbfc3094c70647fd1ad8c4c491ba7bf5',
  '7602330376070ca3681838e49bf7f932179a04d9'
]);
const notionFixtureFile='test/notion-mcp-engine.test.mjs';
const notionFixtureHeader='Bearer ' + 'FIXTURE_PRIVATE_ACCESS';

export function historyMatchProvenance(history,index){
  if(typeof history!=='string'||!Number.isSafeInteger(index)||index<0||index>history.length)
    throw Error('HISTORY_PROVENANCE_INPUT_INVALID');
  const before=history.slice(0,index);
  const marker=before.lastIndexOf('\ncommit ');
  const section=before.slice(marker<0?0:marker+1);
  const commit=/^commit ([0-9a-f]{40})/m.exec(section)?.[1]??'unknown';
  const diff=[...section.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  const candidate=diff.at(-1)?.[2]??'(commit metadata)';
  const file=candidate==='(commit metadata)'?candidate:(/^[a-zA-Z0-9._/-]{1,128}$/.test(candidate)?candidate:'(nonstandard path)');
  return {commit,file};
}

export function isVerifiedSyntheticNotionBearer(type,matched,origin){
  return type==='Bearer token literal' &&
    matched===notionFixtureHeader &&
    notionFixtureCommits.has(origin?.commit) &&
    origin?.file===notionFixtureFile;
}
