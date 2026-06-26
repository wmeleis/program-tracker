const fs=require('fs'); const {JSDOM}=require('jsdom');
const dom=new JSDOM('<!DOCTYPE html>',{url:'http://localhost/'});
global.window=dom.window; global.document=dom.window.document; global.localStorage=dom.window.localStorage;
try{(0,eval)(fs.readFileSync('docs/app.js','utf8'));}catch(e){}
const cc=(typeof compareCurricula==='function')?compareCurricula:window.compareCurricula;
const d=JSON.parse(fs.readFileSync('/tmp/allis.json','utf8'));
for(const pid of Object.keys(d)){
  const {p,r}=d[pid];
  if(!p||!r){console.log(pid+': missing '+(!p?'proposal ':'')+(!r?'reference':''));continue;}
  const res=cc(p,r); const fl=res.diff.filter(x=>x.type&&x.type!=='same');
  const cs=fl.filter(x=>/CSYE|DAMG|INFO|TELE/.test((x.left&&x.left.key)||'')||/CSYE|DAMG|INFO|TELE/.test((x.right&&x.right.key)||''));
  console.log(pid+': flagged='+fl.length+' subjFlagged='+cs.length+' refver='+(d[pid].refver||'').slice(0,40));
}
