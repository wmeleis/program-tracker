const fs=require('fs'); const {JSDOM}=require('jsdom');
const dom=new JSDOM('<!DOCTYPE html><body></body>',{url:'http://localhost/'});
global.window=dom.window; global.document=dom.window.document; global.navigator=dom.window.navigator; global.localStorage=dom.window.localStorage;
try{(0,eval)(fs.readFileSync('static/app.js','utf8'));}catch(e){}
const d=JSON.parse(fs.readFileSync('/tmp/is.json','utf8'));
const bl=extractCourseLines(d.boston);
console.log('Boston wildcards:', JSON.stringify(bl.filter(x=>x.subjectWildcard).map(x=>({k:x.key,excl:x.subjectWildcard.exclusions}))));
for (const [label,ref] of [['ref=Boston92', d.boston],['ref=ref1628', d.ref1628]]) {
  const res=compareCurricula(ref, d.prop);
  const fl=res.diff.filter(x=>x.type&&x.type!=='same');
  const cs=fl.filter(x=>/CSYE/.test((x.left&&x.left.key)||'')||/CSYE/.test((x.right&&x.right.key)||''));
  console.log(label+': flagged='+fl.length+' CSYEflagged='+cs.length);
  cs.slice(0,6).forEach(x=>console.log('   ',x.type,'L:',(x.left&&x.left.key),'R:',(x.right&&x.right.key)));
}
