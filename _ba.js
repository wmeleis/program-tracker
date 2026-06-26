const fs=require('fs'); const {JSDOM}=require('jsdom');
const dom=new JSDOM('<!DOCTYPE html>',{url:'http://localhost/'});
global.window=dom.window; global.document=dom.window.document; global.localStorage=dom.window.localStorage;
try{(0,eval)(fs.readFileSync('/tmp/srv_static_app.js','utf8'));}catch(e){}
const cc=(typeof compareCurricula==='function')?compareCurricula:window.compareCurricula;
const d=JSON.parse(fs.readFileSync('/tmp/allapi.json','utf8'));
for(const id of Object.keys(d)){
  const o=d[id]; if(o.err||!o.p||!o.r){console.log(id+': nodata');continue;}
  const res=cc(o.p,o.r); const fl=res.diff.filter(x=>x.type&&x.type!=='same');
  const cs=fl.filter(x=>/CSYE|DAMG/.test((x.left&&x.left.key)||'')||/CSYE|DAMG/.test((x.right&&x.right.key)||''));
  console.log(id+': flagged='+fl.length+' CSYE/DAMG='+cs.length+' ver='+o.ver);
}
