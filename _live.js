const fs=require('fs'); const {JSDOM}=require('jsdom');
const dom=new JSDOM('<!DOCTYPE html>',{url:'http://localhost/'});
global.window=dom.window; global.document=dom.window.document; global.localStorage=dom.window.localStorage;
try{(0,eval)(fs.readFileSync('/tmp/live_app.js','utf8'));}catch(e){}
const cc=(typeof compareCurricula==='function')?compareCurricula:window.compareCurricula;
const d=JSON.parse(fs.readFileSync('/tmp/live1628.json','utf8'));
const res=cc(d.p,d.r);
const byType={};
res.diff.forEach(x=>{byType[x.type]=(byType[x.type]||0)+1;});
console.log('diff type counts:', JSON.stringify(byType));
const flaggedCSYE=res.diff.filter(x=>x.type!=='same' && (/CSYE/.test((x.left&&x.left.key)||'')||/CSYE/.test((x.right&&x.right.key)||'')));
console.log('CSYE flagged (non-same):', flaggedCSYE.length);
// how many 'same' rows are wildcard-absorbed CSYE?
const absorbed=res.diff.filter(x=>x.type==='same' && /CSYE/.test((x.left&&x.left.key)||'') && /SUBJ:CSYE/.test((x.right&&x.right.key)||''));
console.log('CSYE absorbed-into-wildcard (same):', absorbed.length);
