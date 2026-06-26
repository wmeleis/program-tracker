const fs=require('fs'); const {JSDOM}=require('jsdom');
const dom=new JSDOM('<!DOCTYPE html><body></body>',{url:'http://localhost/'});
global.window=dom.window; global.document=dom.window.document; global.localStorage=dom.window.localStorage;
try{(0,eval)(fs.readFileSync('docs/app.js','utf8'));}catch(e){console.error('LOAD',String(e.message).slice(0,120));}
const has = typeof window.compareCurricula==='function' || typeof compareCurricula==='function';
console.log('compareCurricula present in docs/app.js:', has);
const cc = (typeof compareCurricula==='function')?compareCurricula:window.compareCurricula;
const d=JSON.parse(fs.readFileSync('/tmp/pub.json','utf8'));
const res=cc(d.p, d.r);
const fl=res.diff.filter(x=>x.type&&x.type!=='same');
const cs=fl.filter(x=>/CSYE|DAMG/.test((x.left&&x.left.key)||'')||/CSYE|DAMG/.test((x.right&&x.right.key)||''));
console.log('docs/app.js PUBLISHED inputs: flagged='+fl.length+' CSYE/DAMG='+cs.length);
