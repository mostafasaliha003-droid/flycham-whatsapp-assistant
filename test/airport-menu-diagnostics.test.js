'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {inspectAirportMenu,diagnoseFlyChamAirports}=require('../src/airport-menu-diagnostics');
test('airport diagnostics emit fixed classifications and never raw text or credentials',()=>{
 const node=text=>({textContent:text,getClientRects:()=>[1],querySelector:()=>null,matches:()=>true});
 const nodes=['Dubai International Airport (DXB) Terminal 2','Maktoum (DWC)','private-user secret-token-123456 +971500000000','No results found'].map(node);
 const result=vm.runInNewContext('('+inspectAirportMenu.toString()+')(args)',{args:{origin:'https://reservations.flycham.com',inputId:'fAirport'},location:{origin:'https://reservations.flycham.com'},getComputedStyle:()=>({display:'block',visibility:'visible'}),document:{querySelectorAll:selector=>selector.startsWith('[id=')?[node('')]:nodes}});
 assert.deepEqual(Array.from(result.codes),['DXB','DWC']);assert.equal(result.noMatches,true);assert.ok(result.features.includes('TERMINAL'));
 assert.doesNotMatch(JSON.stringify(result),/private-user|secret-token|971500000000|Terminal 2/);
});
test('startup airport audit only types origin queries and restores search without submitting anything',async()=>{
 const queries=[],reports=[];let opens=0;
 const field={fill:async v=>assert.equal(v,''),pressSequentially:async q=>queries.push(q),press:async k=>assert.equal(k,'Tab')};
 const frame={locator:s=>{assert.equal(s,'#fAirport');return field;},evaluate:async()=>({trusted:true,inputReady:true,codes:[]})};
 await diagnoseFlyChamAirports({openSearchForm:async()=>{opens++;return frame;},page:{waitForTimeout:async()=>{}},report:x=>reports.push(x)});
 assert.equal(opens,2);assert.deepEqual(queries,['Dubai','Maktoum','Abu','Sharjah']);assert.equal(reports.length,4);
});
