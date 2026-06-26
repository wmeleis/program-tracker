const fs=require('fs'); const {JSDOM}=require('jsdom');
const dom=new JSDOM('<!DOCTYPE html>',{url:'http://localhost/'});
global.window=dom.window; global.document=dom.window.document; global.localStorage=dom.window.localStorage;
try{(0,eval)(fs.readFileSync('/tmp/srv_static_app.js','utf8'));}catch(e){console.error('LOAD',String(e.message).slice(0,100));}
const cc=(typeof compareCurricula==='function')?compareCurricula:window.compareCurricula;
const d=JSON.parse(fs.readFileSync('/tmp/api1628.json','utf8'));
const res=cc(d.p,d.r);  // loadCompareDetail uses compareCurricula(currHtml, refHtml)
const byType={}; res.diff.forEach(x=>byType[x.type]=(byType[x.type]||0)+1);
console.log('RESULT type counts:', JSON.stringify(byType));
const flagged=res.diff.filter(x=>x.type&&x.type!=='same');
console.log('total flagged:', flagged.length);
flagged.slice(0,15).forEach(x=>console.log('  ',x.type,'L:',x.left&&x.left.key,'R:',x.right&&x.right.key));
