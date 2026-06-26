const fs=require('fs'); const {JSDOM}=require('jsdom');
const dom=new JSDOM('<!DOCTYPE html>',{url:'http://localhost/'});
global.window=dom.window; global.document=dom.window.document; global.localStorage=dom.window.localStorage;
try{(0,eval)(fs.readFileSync('static/app.js','utf8'));}catch(e){}
const cc=compareCurricula, rs=renderSideBySide;
const d=JSON.parse(fs.readFileSync('/tmp/api1628.json','utf8'));
const res=cc(d.p,d.r);
const html=rs(res.diff,'Proposed','Reference');
const tmp=dom.window.document.createElement('div'); tmp.innerHTML=html;
const redCells=[...tmp.querySelectorAll('.cmp-c-left, .cmp-c-right')];
const csyeRed=redCells.filter(s=>/CSYE/.test(s.textContent));
console.log('total colored(red/green) code spans:', redCells.length);
console.log('CSYE colored spans:', csyeRed.length, csyeRed.slice(0,6).map(s=>s.textContent.trim()));
