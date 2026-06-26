const fs=require('fs'); const {JSDOM}=require('jsdom');
const dom=new JSDOM('<!DOCTYPE html><body></body>',{url:'http://localhost/'});
global.window=dom.window; global.document=dom.window.document; global.localStorage=dom.window.localStorage;
try{(0,eval)(fs.readFileSync('static/app.js','utf8'));}catch(e){console.error('LOAD ERR',e.message);}
console.log('fns:', typeof compareCurricula, typeof extractCourseLines);
const d=JSON.parse(fs.readFileSync('/tmp/is2.json','utf8'));
function rep(label,a,bb){
  try{
    const res=compareCurricula(a,bb);
    const fl=res.diff.filter(x=>x.type&&x.type!=='same');
    const cs=fl.filter(x=>/CSYE|DAMG/.test((x.left&&x.left.key)||'')||/CSYE|DAMG/.test((x.right&&x.right.key)||''));
    console.log(label+': total flagged='+fl.length+' CSYE/DAMG='+cs.length);
    cs.slice(0,8).forEach(x=>console.log('   ',x.type,'L:',x.left&&x.left.key,'R:',x.right&&x.right.key));
  }catch(e){console.log(label+' ERR '+e.message);}
}
rep('prop vs ref1628', d.p, d.r);
rep('prop vs boston92', d.p, d.b);
