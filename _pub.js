const fs=require('fs'); const {JSDOM}=require('jsdom');
const dom=new JSDOM('<!DOCTYPE html><body></body>',{url:'http://localhost/'});
global.window=dom.window; global.document=dom.window.document; global.localStorage=dom.window.localStorage;
try{(0,eval)(fs.readFileSync('static/app.js','utf8'));}catch(e){}
const d=JSON.parse(fs.readFileSync('/tmp/pub.json','utf8'));
// static order: compareCurricula(currHtml, refHtml)
const res=compareCurricula(d.p, d.r);
const fl=res.diff.filter(x=>x.type&&x.type!=='same');
const cs=fl.filter(x=>/CSYE|DAMG/.test((x.left&&x.left.key)||'')||/CSYE|DAMG/.test((x.right&&x.right.key)||''));
console.log('PUBLISHED inputs: total flagged='+fl.length+' CSYE/DAMG flagged='+cs.length);
cs.slice(0,12).forEach(x=>console.log('   ',x.type,'L:',x.left&&x.left.key,'R:',x.right&&x.right.key));
