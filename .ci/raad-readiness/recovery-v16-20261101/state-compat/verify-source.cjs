'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const TREE='3c67dbdd818448f102395581a8dac32004eca5d2';
const PIN='4b03f12a2c7d0af6e7c9dc6c1decb8dbbe588f22105fd40ff12dbdd120bb5c3c';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function verifyApprovedSource({source,freeze}={}){
 if(typeof source!=='string'||!path.isAbsolute(source)||typeof freeze!=='string'||!path.isAbsolute(freeze))throw Error('EXPLICIT_PINNED_SOURCE_REQUIRED');
 const root=fs.realpathSync(source),file=fs.realpathSync(freeze),bytes=fs.readFileSync(file),manifest=JSON.parse(bytes);
 if(sha(bytes)!==PIN||manifest.candidateTree!==TREE||Object.keys(manifest.files||{}).length!==445)throw Error('PINNED_SOURCE_MANIFEST_MISMATCH');
 for(const [name,row]of Object.entries(manifest.files)){
  if(path.isAbsolute(name)||name.split('/').some(v=>v==='..'||v==='.')||name.includes('\\'))throw Error('SOURCE_PATH_INVALID');
  const p=path.join(root,name),st=fs.lstatSync(p),raw=fs.readFileSync(p);
  if(!st.isFile()||st.isSymbolicLink()||raw.length!==row.bytes||sha(raw)!==row.sha256||(st.mode&0o111?'100755':'100644')!==row.mode)throw Error('SOURCE_FILE_CHANGED');
 }
 return{source:root,freeze:file,manifest};
}
module.exports={verifyApprovedSource,PIN,TREE};
