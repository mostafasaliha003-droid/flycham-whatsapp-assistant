'use strict';
// PDF-only test variant: keep the network/browser fence; allow two installed
// converters on synthetic source.pdf files in this process's private TMPDIR.
const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),util=require('node:util');
const nativeExecFile=cp.execFile;
require('./offline-loopback-guard.cjs');
const temporary=fs.realpathSync(process.env.TMPDIR);
const binaries={pdfinfo:['/opt/codex/runtimes/codex-primary-runtime/dependencies/bin/override/pdfinfo','/usr/bin/pdfinfo'],pdftoppm:['/opt/codex/runtimes/codex-primary-runtime/dependencies/bin/override/pdftoppm','/usr/bin/pdftoppm']};
function deny(){return require('./offline-loopback-guard.cjs').blocked('pdf-exec-rejected','execFile');}
function inputFile(value){if(typeof value!=='string'||!path.isAbsolute(value))deny();const actual=fs.realpathSync(value),parent=path.dirname(actual),stat=fs.statSync(actual);if(!actual.startsWith(temporary+path.sep)||path.basename(actual)!=='source.pdf'||!/^raad-pdf-[A-Za-z0-9]+$/.test(path.basename(parent))||!stat.isFile()||stat.size>25*1024*1024)deny();return actual;}
function checked(command,args,options,callback){
 if(!Object.hasOwn(binaries,command)||!Array.isArray(args)||args.some(x=>typeof x!=='string')||!options||options.shell||options.env||options.cwd||typeof callback!=='function')deny();
 let input;
 if(command==='pdfinfo'){if(args.length!==1)deny();input=inputFile(args[0]);}
 else {if(args.length!==9||args[0]!=='-png'||args[1]!=='-scale-to'||args[2]!=='1800'||args[3]!=='-f'||args[5]!=='-l'||!/^([1-9]|10)$/.test(args[4])||!/^([1-9]|10)$/.test(args[6])||Number(args[4])>Number(args[6]))deny();input=inputFile(args[7]);const parent=fs.realpathSync(path.dirname(args[8]));if(parent!==path.dirname(input)||path.basename(args[8])!=='page')deny();}
 const binary=binaries[command].find(p=>fs.existsSync(p));if(!binary)deny();
 if(process.env.ISOLATED_PDF_ALLOW_LOG)fs.appendFileSync(process.env.ISOLATED_PDF_ALLOW_LOG,JSON.stringify({tool:command})+'\n');
 return nativeExecFile(binary,args,{timeout:Math.min(Number(options.timeout)||20000,20000),maxBuffer:65536,windowsHide:true},callback);
}
checked[util.promisify.custom]=function(command,args,options){return new Promise((resolve,reject)=>checked(command,args,options,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));};
cp.execFile=checked;
