import fs from 'node:fs';

const admin=fs.readFileSync('tester-diagnostics-admin-v44.mjs','utf8');
const publicDiag=fs.readFileSync('tester-diagnostics-v44.mjs','utf8');
const app=fs.readFileSync('app-v42-patch.js','utf8');
const html=fs.readFileSync('index.html','utf8');

function need(ok,message){if(!ok){console.error(`ADMIN_DIAGNOSTICS_CRITIC_FAIL ${message}`);process.exit(1);}}

need(admin.includes("const REPO='matthewcodergamer/Render360'"),'repository target missing');
need(admin.includes("'/issues'" )||admin.includes('/issues`'),'GitHub Issues write endpoint missing');
need(admin.includes("'authorization':`Bearer ${adminToken}`"),'authenticated GitHub issue write missing');
need(admin.includes("let adminToken=''"),'session token closure missing');
need(admin.includes("adminToken=candidate"),'token connect path missing');
need(admin.includes("adminToken='';connectedLogin=''"),'token disconnect/erase path missing');
need(!/localStorage\.setItem\([^\n]*adminToken/i.test(admin),'admin token must never be persisted to localStorage');
need(!/sessionStorage\.setItem\([^\n]*adminToken/i.test(admin),'admin token must never be persisted to sessionStorage');
need(!/globalThis\.[A-Za-z0-9_$]*token\s*=\s*adminToken/i.test(admin),'admin token must never be exposed on globalThis');
need(admin.includes("Issues = Read and write"),'least-privilege token guidance missing');
need(admin.includes('sentFingerprints'),'diagnostic de-duplication missing');
need(admin.includes('render360:runtimeBlocker')&&admin.includes('render360:fatalError'),'automatic blocker listeners missing');
need(publicDiag.includes('RENDER360_DIAGNOSTICS_ENDPOINT'),'public collector hook missing');
need(publicDiag.includes('github.com/${REPO}/issues/new'),'public pre-filled issue fallback missing');
need(publicDiag.includes('REDACTED_GITHUB_TOKEN'),'public token redaction missing');
need(publicDiag.includes('Game file bytes are never included')||publicDiag.includes('No game image/file contents are included'),'game-content privacy statement missing');
need(publicDiag.includes("tester-diagnostics-admin-v44.mjs?v=44.18"),'admin module not wired into tester diagnostics');
need(app.includes("tester-diagnostics-v44.mjs?v=44.18"),'app cache-bust not updated');
need(html.includes('app-v42-patch.js?v=44.18'),'index cache-bust not updated');

console.log('ADMIN_SESSION_TOKEN_NONPERSISTENT=PASS');
console.log('ADMIN_DIRECT_GITHUB_ISSUES=PASS');
console.log('PUBLIC_TESTER_FALLBACK=PASS');
console.log('DIAGNOSTIC_PRIVACY_REDACTION=PASS');
console.log('DIAGNOSTIC_DEDUPLICATION=PASS');
console.log('ADMIN_DIAGNOSTICS_CRITIC=PASS');
