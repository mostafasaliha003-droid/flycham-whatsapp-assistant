'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {submitProbe,chooseSearchCarrier}=require('../src/portal-search-probe');
const G9={value:'observed-g9-enum',textContent:'Search G9'};
const THREE={value:'observed-3l-enum',textContent:'Air Arabia Abu Dhabi (3L)'};
const ALL={value:'observed-group-enum',textContent:'Search All'};
const XH={value:'observed-xh-enum',textContent:'Search XH'};

// These are synthetic DOM options, not a claim about any live agent portal.
function carrierDOM({options=[G9,THREE,ALL,XH],supplier='airarabia',reset,duplicate=false,hidden=false,disabled=false,foreign=false,autoDefault}={}){
 const calls=[],reports=[],values={};
 let carrierSelections=0;
 const option=(o)=>({...o,disabled:Boolean(o.disabled),parentElement:{disabled:Boolean(o.groupDisabled)}});
 const select={tagName:'SELECT',value:'initial-enum',disabled,options:options.map(option),getClientRects:()=>hidden?[]:[1]};
 const fields={selSearchOptions:select,selectedCurrency:{tagName:'SELECT',options:[{value:'AED',textContent:'AED'}],value:'AED'},classOfService:{tagName:'SELECT',options:[{value:'observed-economy',textContent:'Economy'}]},bookingType:{tagName:'SELECT',options:[{value:'observed-normal',textContent:'Normal'}]}};
 for(const id of ['fromAirport','toAirport','fAirport','tAirport','departureDate','returnDate','adultCount','childCount','infantCount'])fields[id]={value:''};
 const radios=[{value:'OW',checked:true,disabled:false},{value:'R',checked:false,disabled:false}];
 const document={getElementById:id=>fields[id],querySelectorAll:selector=>selector==='[id="selSearchOptions"]'?(duplicate?[select,{...select}]:[select]):selector==='input[name="searchType"][type="radio"]'?radios:[]};
 const sandbox={document,location:{origin:foreign?'https://other.example':supplier==='flycham'?'https://reservations.flycham.com':'https://agents.airarabia.com'},getComputedStyle:()=>({display:'block',visibility:'visible'})};
 const run=(fn,args)=>vm.runInNewContext('('+fn.toString()+')(args)',{...sandbox,args});
 const frame={
  evaluate:async(fn,args)=>{
   if(fn.name==='airportSuggestionAction'){calls.push(['airport',args.inputId,args.code,args.operation]);return{status:args.operation==='input'?'INPUT_READY':'READY'};}
   if(!args&&!fn.toString().includes('selectedCurrency'))return 0;
   return run(fn,args);
  },
  evaluateHandle:async(fn,args)=>({asElement:()=>({click:async()=>{calls.push(['airport-click',args.inputId,args.code]);fields[args.inputId==='fAirport'?'fromAirport':'toAirport'].value=args.code;if(args.inputId==='tAirport'&&autoDefault){
   // The carrier branch is from the observed supplier setDefaultSearchOption:
   // route carrier arrays differing from carrierCode select INT, otherwise AA.
   // Execute that branch in a VM; no supplier function is invoked in production.
   vm.runInNewContext('var G=false;var P=O[3].split(",");for(var F=0;F<P.length;F++){if(P[F]!=carrierCode){G=true;break;}}if(G){$("#selSearchOptions").val("INT");}else{$("#selSearchOptions").val("AA");}',{O:[null,null,null,autoDefault.routeCarriers],carrierCode:autoDefault.carrierCode,$:()=>({val:value=>{calls.push(['supplier-auto-default',value]);select.value=value;}})});
  }}}),dispose:async()=>{}}),
  locator:selector=>{
   const id=selector.slice(1),field=fields[id];
   const locator={
    fill:async value=>{assert.ok(!['fromAirport','toAirport'].includes(id),'never fill supplier hidden airport fields');calls.push(['fill',id,value]);if(field)field.value=value;values[selector]=value;
     if(id==='adultCount'&&reset){if(['keeps-resetting','reselect-clears-route','reselect-clears-date','reselect-changes-currency','reselect-changes-party','reselect-changes-trip','reselect-changes-class','reselect-changes-booking-type'].includes(reset))select.value=G9.value;else if(reset==='unobserved-value')select.value='not-an-observed-option';else if(reset==='label')select.options.find(o=>o.value===select.value).textContent='Search G9';else if(reset==='disabled')select.options.find(o=>o.value===select.value).disabled=true;else if(reset==='route')fields.fromAirport.value='SHJ';}
    },
    pressSequentially:async value=>{calls.push(['type',id,value]);field.value=value;},press:async()=>{},
    inputValue:async()=>field?.value||'',
    nth:()=>locator,check:async()=>{calls.push(['one-way']);radios[0].checked=true;radios[1].checked=false;},
    selectOption:async value=>{calls.push(['select',id,value]);field.value=value;if(id==='selSearchOptions'){
     carrierSelections++;
     if(carrierSelections===1||reset==='reselect-clears-route')for(const name of ['fromAirport','toAirport','fAirport','tAirport'])fields[name].value='';
     if(carrierSelections>1){if(reset==='keeps-resetting')select.value=G9.value;else if(reset==='reselect-clears-date')fields.departureDate.value='';else if(reset==='reselect-changes-currency')fields.selectedCurrency.value='USD';else if(reset==='reselect-changes-party')fields.adultCount.value='2';else if(reset==='reselect-changes-class')fields.classOfService.value='observed-business';else if(reset==='reselect-changes-booking-type')fields.bookingType.value='observed-non-normal';else if(reset==='reselect-changes-trip'){radios[0].checked=false;radios[1].checked=true;}}
    }},
    click:async()=>calls.push(['search',selector]),count:async()=>1,isVisible:async()=>true,
   };return locator;
  },
 };
 return{frame,select,fields,calls,reports,values,config:(origin='AUH',destination='DAM')=>({origin,destination,departureDate:'11/11/2026',requestTripType:'one_way',supplier,report:code=>reports.push(code)})};
}

for(const [origin,destination]of [['AUH','DAM'],['DAM','AUH'],['AUH','ALP'],['ALP','AUH']])test('selects observed 3L before airport autocomplete and verifies it for '+origin+'–'+destination,async()=>{
 const f=carrierDOM();await submitProbe(f.frame,f.config(origin,destination));
 const carrierIndex=f.calls.findIndex(c=>c[0]==='select'&&c[1]==='selSearchOptions');
 assert.ok(carrierIndex>=0&&carrierIndex<f.calls.findIndex(c=>c[0]==='airport'));
 assert.equal(f.calls[carrierIndex][2],THREE.value);assert.equal(f.select.value,THREE.value);
 assert.equal(f.fields.fromAirport.value,origin);assert.equal(f.fields.toAirport.value,destination);assert.equal(f.fields.departureDate.value,'11/11/2026');
 assert.ok(f.calls.some(c=>c[0]==='search'));assert.ok(f.reports.includes('PORTAL_SEARCH_CARRIER_3L_EXPLICIT_SELECTED'));assert.ok(f.reports.includes('PORTAL_SEARCH_CARRIER_3L_EXPLICIT_CONFIRMED'));
 assert.ok(f.reports.every(c=>/^[A-Z0-9_]+$/.test(c)));assert.ok(!f.reports.some(c=>c.includes('observed-')));
});

for(const textContent of ['3L','Search 3L','Air Arabia Abu Dhabi','Air Arabia (3L)'])test('uses the actual value of explicit observed 3L label '+textContent,async()=>{
 const f=carrierDOM({options:[{value:'supplier-enum-from-dom',textContent},ALL]});await submitProbe(f.frame,f.config());assert.equal(f.select.value,'supplier-enum-from-dom');
});

for(const [origin,destination]of [['AUH','DAM'],['DAM','AUH']])test('falls back only to a unique observed Search All label for '+origin+'–'+destination,async()=>{
 const f=carrierDOM({options:[G9,ALL]});await submitProbe(f.frame,f.config(origin,destination));assert.equal(f.select.value,ALL.value);assert.ok(f.reports.includes('PORTAL_SEARCH_CARRIER_3L_SEARCH_ALL_CONFIRMED'));assert.equal(f.fields.fromAirport.value,origin);
});

for(const [name,options]of [
 ['no 3L or Search All',[G9]],
 ['only an unlabelled guessed 3L enum',[{value:'3L',textContent:'Other carrier'}]],
 ['two explicit 3L labels',[THREE,{value:'second-3l',textContent:'Search 3L'},ALL]],
 ['disabled explicit 3L',[G9,{...THREE,disabled:true},ALL]],
 ['disabled 3L optgroup',[{...THREE,groupDisabled:true},ALL]],
 ['duplicate actual explicit option value',[THREE,{value:THREE.value,textContent:'Another option'},ALL]],
 ['two Search All labels',[G9,ALL,{value:'other-all',textContent:'Search All'}]],
 ['disabled Search All',[G9,{...ALL,disabled:true}]],
 ['Search All enum with unrelated label',[G9,{value:'Search All',textContent:'Other service'}]],
 ])test('does not search when carrier selection is unverified: '+name,async()=>{
 const f=carrierDOM({options});await assert.rejects(submitProbe(f.frame,f.config()),/SEARCH_CARRIER_NOT_CONFIRMED/);assert.ok(!f.calls.some(c=>c[0]==='search'||c[0]==='airport'));
});

for(const [name,options]of [['hidden select',{hidden:true}],['disabled select',{disabled:true}],['duplicate select ID',{duplicate:true}],['foreign origin',{foreign:true}]])test('refuses '+name+' before airport or search operations',async()=>{
 const f=carrierDOM(options);await assert.rejects(submitProbe(f.frame,f.config()),/SEARCH_CARRIER_NOT_CONFIRMED/);assert.ok(!f.calls.some(c=>c[0]==='airport'||c[0]==='search'));
});

for(const reset of ['keeps-resetting','unobserved-value','label','disabled','route'])test('rechecks the selected supplier option and route after form changes: '+reset,async()=>{
 const f=carrierDOM({reset});await assert.rejects(submitProbe(f.frame,f.config()),reset==='route'?/SEARCH_INPUTS_NOT_CONFIRMED/:/SEARCH_CARRIER_NOT_CONFIRMED/);assert.ok(!f.calls.some(c=>c[0]==='search'));
 if(reset!=='route')assert.ok(f.reports.includes('PORTAL_SEARCH_CARRIER_SELECTION_CHANGED'));
});

for(const [origin,destination]of [['SHJ','DAM'],['DAM','SHJ']])test('recovers G9 once after the primary supplier route-carrier branch chooses INT: '+origin+'–'+destination,async()=>{
 const f=carrierDOM({options:[{value:'AA',textContent:'Search G9'},{value:'INT',textContent:'Search All'}],autoDefault:{routeCarriers:'G9,3L',carrierCode:'G9'}});
 const prepared=await submitProbe(f.frame,f.config(origin,destination));assert.equal(f.select.value,'AA');assert.deepEqual(prepared.carrier,{value:'AA',carrier:'G9',mode:'EXPLICIT'});assert.equal(prepared.currency,'AED');
 assert.deepEqual(f.calls.filter(c=>c[0]==='supplier-auto-default').map(c=>c[1]),['INT']);assert.equal(f.calls.filter(c=>c[0]==='select'&&c[1]==='selSearchOptions').length,2);assert.equal(f.calls.filter(c=>c[0]==='search').length,1);assert.ok(f.reports.includes('PORTAL_SEARCH_CARRIER_G9_EXPLICIT_RESELECTED'));assert.equal(f.fields.fromAirport.value,origin);assert.equal(f.fields.toAirport.value,destination);
});
for(const [origin,destination]of [['AUH','DAM'],['DAM','AUH']])test('retains observed Search All after the primary supplier 3L route defaults to INT: '+origin+'–'+destination,async()=>{
 const f=carrierDOM({options:[{value:'AA',textContent:'Search G9'},{value:'INT',textContent:'Search All'}],autoDefault:{routeCarriers:'3L',carrierCode:'G9'}});
 const prepared=await submitProbe(f.frame,f.config(origin,destination));assert.deepEqual(prepared.carrier,{value:'INT',carrier:'3L',mode:'SEARCH_ALL'});assert.equal(f.select.value,'INT');assert.equal(f.calls.filter(c=>c[0]==='select'&&c[1]==='selSearchOptions').length,1);assert.equal(f.calls.filter(c=>c[0]==='search').length,1);
});
test('recovers FlyCham XH once after the shared supplier route branch chooses INT',async()=>{
 const f=carrierDOM({supplier:'flycham',options:[{value:'AA',textContent:'Search XH'},{value:'INT',textContent:'Search All'}],autoDefault:{routeCarriers:'XH,G9',carrierCode:'XH'}});
 const prepared=await submitProbe(f.frame,f.config('SHJ','DAM'));assert.deepEqual(prepared.carrier,{value:'AA',carrier:'XH',mode:'EXPLICIT'});assert.equal(f.calls.filter(c=>c[0]==='select'&&c[1]==='selSearchOptions').length,2);assert.equal(f.calls.filter(c=>c[0]==='search').length,1);assert.ok(f.reports.includes('PORTAL_SEARCH_CARRIER_XH_EXPLICIT_RESELECTED'));
});
for(const reset of ['reselect-clears-route','reselect-clears-date','reselect-changes-currency','reselect-changes-party','reselect-changes-trip','reselect-changes-class','reselect-changes-booking-type'])test('does not search if the single normal carrier reselection changes customer inputs: '+reset,async()=>{
 const f=carrierDOM({reset});await assert.rejects(submitProbe(f.frame,f.config()),/SEARCH_INPUTS_NOT_CONFIRMED/);assert.equal(f.calls.filter(c=>c[0]==='select'&&c[1]==='selSearchOptions').length,2);assert.ok(!f.calls.some(c=>c[0]==='search'));
});
test('does not loop when normal carrier reselection does not stick',async()=>{
 const f=carrierDOM({reset:'keeps-resetting'});await assert.rejects(submitProbe(f.frame,f.config()),/SEARCH_CARRIER_NOT_CONFIRMED/);assert.equal(f.calls.filter(c=>c[0]==='select'&&c[1]==='selSearchOptions').length,2);assert.ok(!f.calls.some(c=>c[0]==='search'));
});

for(const [origin,destination]of [['SHJ','DAM'],['DAM','SHJ']])test('preserves G9 selection for '+origin+'–'+destination,async()=>{
 const f=carrierDOM();await submitProbe(f.frame,f.config(origin,destination));assert.equal(f.select.value,G9.value);assert.ok(f.reports.includes('PORTAL_SEARCH_CARRIER_G9_EXPLICIT_CONFIRMED'));
});
test('does not silently change a Sharjah G9 search to Search All',async()=>{
 const f=carrierDOM({options:[THREE,ALL]});await assert.rejects(submitProbe(f.frame,f.config('SHJ','DAM')),/SEARCH_CARRIER_NOT_CONFIRMED/);assert.ok(!f.calls.some(c=>c[0]==='search'));
});
test('preserves FlyCham XH selection even when an AUH code appears in a synthetic form',async()=>{
 const f=carrierDOM({supplier:'flycham'});await submitProbe(f.frame,f.config('AUH','DAM'));assert.equal(f.select.value,XH.value);assert.ok(f.reports.includes('PORTAL_SEARCH_CARRIER_XH_EXPLICIT_CONFIRMED'));
});
test('invalid carrier enum or untrusted source never reaches a select operation',async()=>{
 for(const options of [[{value:'',textContent:'Search 3L'}],[{value:'x'.repeat(81),textContent:'Search 3L'}]]){
  const f=carrierDOM({options});await assert.rejects(chooseSearchCarrier(f.frame,{supplier:'airarabia',origin:'AUH',destination:'DAM',report:()=>{}}),/SEARCH_CARRIER_NOT_CONFIRMED/);assert.ok(!f.calls.some(c=>c[0]==='select'));
 }
});
