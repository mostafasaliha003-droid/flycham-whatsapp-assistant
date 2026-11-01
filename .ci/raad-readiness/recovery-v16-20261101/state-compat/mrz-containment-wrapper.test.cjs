'use strict';
// Reuse the immutable v15 fixture assertions; only source admission is rebound.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module'),test=require('node:test');
const {verifyApprovedSource}=require('./verify-source.cjs');
const approved=verifyApprovedSource({source:process.env.INTEGRATION_LAB_SOURCE,freeze:process.env.INTEGRATION_LAB_FREEZE});
const base=process.env.STATE_COMPAT_BASE_TEST;
if(typeof base!=='string'||!path.isAbsolute(base))throw Error('EXPLICIT_IMMUTABLE_BASE_FIXTURE_REQUIRED');
const bytes=fs.readFileSync(base);
if(crypto.createHash('sha256').update(bytes).digest('hex')!=='fc248ad99e999c5b241fb3ee2798affb591af9399be72e67749f15d15e8d900c')throw Error('BASE_FIXTURE_CHANGED');
const old="const {verifyApprovedSource} = require('../lab-boundary.cjs');";
const original=bytes.toString('utf8');if(original.split(old).length!==2)throw Error('EXACT_VERIFIER_IMPORT_REQUIRED');
const source=original.replace(old,'const {verifyApprovedSource} = require('+JSON.stringify(path.join(__dirname,'verify-source.cjs'))+');');
const loaded=new Module(base,module);loaded.filename=base;loaded.paths=Module._nodeModulePaths(path.dirname(base));loaded._compile(source,base);
test.after(()=>verifyApprovedSource({source:approved.source,freeze:approved.freeze}));
