import fs from 'node:fs';

const src=fs.readFileSync(new URL('./tester-diagnostics-v44.mjs',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('./app-v42-patch.js',import.meta.url),'utf8');
const checks=[
  ['WIRED_IN_APP',app.includes("import './tester-diagnostics-v44.mjs?v=44.18';")],
  ['NO_EMBEDDED_GITHUB_AUTH_HEADER',!src.includes("headers:{'authorization'")&&!src.includes('Authorization: `Bearer')],
  ['OWNER_CONTROLLED_HTTPS_ENDPOINT',src.includes('RENDER360_DIAGNOSTICS_ENDPOINT')&&src.includes("/^https:\\/\\//i")],
  ['GITHUB_ISSUE_FALLBACK',src.includes(`https://github.com/${'${REPO}'}/issues/new`)],
  ['BLOCKER_CAPTURE',src.includes("render360:runtimeBlocker")&&src.includes("render360:fatalError")&&src.includes("stage||'').toLowerCase()==='blocked'" )],
  ['DEDUP_QUEUE',src.includes('fingerprint===envelope.fingerprint')&&src.includes('MAX_QUEUE=20')],
  ['PRIVACY_REDACTION',src.includes('[REDACTED_GITHUB_TOKEN]')&&src.includes('[REDACTED_EMAIL]')&&src.includes('[REDACTED_LOCAL_PATH]')],
  ['NO_GAME_BYTES',src.includes('No game image/file contents are included')&&src.includes("'[omitted]'" )],
  ['TESTER_SETTINGS',src.includes('Tester Diagnostics')&&src.includes('Collect Test Reports')&&src.includes('Send Latest Diagnostic')],
  ['CONSOLE_SEND_BUTTON',src.includes("send.id='r360DevSend'")],
];
let failed=false;
for(const [name,ok] of checks){console.log(`${name}=${ok?'PASS':'FAIL'}`);if(!ok)failed=true;}
if(failed)process.exit(1);
console.log('TESTER_DIAGNOSTICS_CRITIC=PASS');
