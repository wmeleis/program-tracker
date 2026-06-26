import { JSDOM } from 'jsdom';

const BASE = 'http://localhost:5055';
// Pre-fetch the page HTML + app.js + the API payloads node-side.
const pageHtml = await (await fetch(BASE + '/')).text();
const appJs = await (await fetch(BASE + '/static/app.js')).text();

const api = {};
for (const p of ['/api/pipeline','/api/programs','/api/changes','/api/scan/status','/api/colleges','/api/approvers','/api/workflow_roles']) {
  try { api[p] = await (await fetch(BASE + p)).json(); } catch(e){ api[p] = {}; }
}

const dom = new JSDOM(pageHtml, { runScripts: 'outside-only', pretendToBeVisual: true, url: BASE + '/' });
const { window } = dom;
// localStorage: select College perspective + Khoury BEFORE app boots.
window.localStorage.setItem('cim-perspective','college');
window.localStorage.setItem('cim-college-selected','Khoury Coll of Comp Sciences');
// stub fetch to serve the pre-fetched API
window.fetch = (u) => {
  const path = (''+u).replace(BASE,'').split('?')[0];
  const body = api[path] ?? {};
  return Promise.resolve({ ok:true, json:()=>Promise.resolve(body), text:()=>Promise.resolve(JSON.stringify(body)) });
};
window.scrollTo = ()=>{};
// run app.js in the window
window.eval(appJs);

// give microtasks/promises time
await new Promise(r => setTimeout(r, 400));
// force the programs view + render
try { window.eval("currentView='programs'; cimPerspective='college'; cimCollegeSelected='Khoury Coll of Comp Sciences';"); } catch(e){}
try { await window.applyFilters(); } catch(e){ console.log('applyFilters err', e.message); }
await new Promise(r => setTimeout(r, 200));

const tog = window.document.getElementById('pipeline-panel-toggle');
console.log('toggle exists:', !!tog);
if (tog) {
  console.log('  inline display:', JSON.stringify(tog.style.display));
  console.log('  innerHTML:', JSON.stringify(tog.innerHTML));
  console.log('  computed display:', window.getComputedStyle(tog).display);
}
const bar = window.document.getElementById('pipeline-bar');
console.log('bar tiles:', bar ? bar.querySelectorAll('.pipeline-step').length : 'no bar');
