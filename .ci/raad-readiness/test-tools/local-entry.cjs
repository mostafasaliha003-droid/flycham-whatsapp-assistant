'use strict';
// Local test entry point. Never load a live environment or launch a browser.
const path=require('node:path');
const guard=path.join(__dirname,'offline-loopback-guard.cjs');
if(!require.cache[guard])throw Error('ISOLATED_TRANSPORT_FENCE_REQUIRED');
for(const key of ['DRY_RUN'])if(process.env[key]!=='true')throw Error('ISOLATED_FLAGS_REQUIRED');
for(const key of ['SAUDI_VISA_ENABLED','RAAD_VISA_AUTOMATION_ENABLED','FARE_CATALOG_ENABLED','CONSULTANT_ORCHESTRATOR_ENABLED'])if(process.env[key]!=='false')throw Error('ISOLATED_FLAGS_REQUIRED');
for(const key of ['WHATSAPP_ACCESS_TOKEN','RAAD_JOB_BRIDGE_KEY','RAAD_BROWSER_WORKER_URL','RAAD_MOFA_USERNAME','RAAD_MOFA_PASSWORD'])if(process.env[key])throw Error('LIVE_CONFIGURATION_FORBIDDEN');
const mode=process.argv[2];
let server;
if(mode==='main')server=require('../test-build/src/server').createServer();
else if(mode==='raad')server=require('../test-build/src/raad-login-pilot/server').createPilot({env:{RAAD_PILOT_KEY:'isolated_test_key_'.repeat(3),RAAD_PILOT_ORIGIN:'https://isolated.invalid'},launch:async()=>{throw Error('BROWSER_DISABLED_IN_LOCAL_TEST');}}).server;
else throw Error('USE_MAIN_OR_RAAD');
const port=Number(process.env.PORT||0);if(!Number.isInteger(port)||port<0||port>65535)throw Error('INVALID_LOCAL_PORT');
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({isolated:true,mode,host:'127.0.0.1',port:server.address().port,browserDisabled:true})));
process.once('SIGTERM',()=>server.close(()=>process.exit(0)));
process.once('SIGINT',()=>server.close(()=>process.exit(0)));
