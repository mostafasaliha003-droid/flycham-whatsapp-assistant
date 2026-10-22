'use strict';
async function readFlightTimes(frame,oneWay=false){
 return frame.evaluate(oneWay=>{
  if(location.origin!=='https://agents.airarabia.com')throw Error('UNTRUSTED');
  const clean=v=>{const s=String(v||'').replace(/\s+/g,' ').trim();return s.length<=120&&/^[\p{L}\p{N}\s:.,/+()-]+$/u.test(s)?s:null;};
  const read=(id,name)=>{
    const table=document.getElementById(id),cols=table?.p?.colModel;
    if(!Array.isArray(cols))throw Error('FLIGHT_GRID_UNCONFIRMED');
    const index=field=>cols.findIndex(c=>c.name===field);
    const ns=['flightNoList','depatureList','arrivalList'].map(index);
    if(ns.some(i=>i<0))throw Error('FLIGHT_COLUMNS_UNCONFIRMED');
    return Array.from(table.querySelectorAll('tr.jqgrow')).flatMap(row=>{
      const radio=row.querySelector('input[name="'+name+'"]');
      if(!radio || radio.disabled || !/^\d+$/.test(radio.value))return [];
      const cells=ns.map(i=>clean(row.cells[i]?.innerText||row.cells[i]?.textContent));
      if(cells.some(v=>!v)||!cells.slice(1).every(v=>/\b\d{1,2}:\d{2}\b/.test(v)))throw Error('FLIGHT_TIMES_UNCONFIRMED');
      return [{row:Number(radio.value),flight:cells[0],departure:cells[1],arrival:cells[2],selected:radio.checked}];
    });
  };
  return {out:read('tblOutboundFlights','depatureSelection'),back:oneWay?[]:read('tblInboundFlights','returnSelection')};
 },oneWay);
}
async function selectFlightTimes(frame,choice){
 const current=await readFlightTimes(frame,!choice.back);
 for(const [leg,name]of [['out','depatureSelection'],['back','returnSelection']]){
  const wanted=choice[leg];if(!wanted)continue;
  const found=current[leg].find(f=>f.row===wanted.row);
  if(!found || ['flight','departure','arrival'].some(k=>found[k]!==wanted[k]))throw Error('FLIGHT_OPTION_CHANGED');
  if(found.selected)continue;
  const visible=frame.locator('input[name="'+name+'"][value="'+wanted.row+'"]:visible');
  if(await visible.count()===0){
    const summary=leg==='out'?'smrySlctionOutgoing':'smrySlctionReturn';
    const change=frame.locator('#'+summary+' button[onclick*="changeFlightSectionClick"]:visible');
    if(await change.count()!==1)throw Error('FLIGHT_CHANGE_CONTROL_UNCONFIRMED');
    await change.click({timeout:15000});
  }
  await frame.locator('input[name="'+name+'"][value="'+wanted.row+'"]:visible').check({timeout:15000});
  const confirm=frame.locator('#'+(leg==='out'?'outbound':'inbound')+'ConfirmSelectionAnchor:visible');
  if(await confirm.count()===1)await confirm.click({timeout:15000});
 }
 await frame.waitForFunction(()=>typeof jQuery!=='undefined'&&jQuery.active===0,null,{timeout:45000});
 const fq=frame.locator('#btnFQ:visible');if(await fq.count()===1)await fq.click({timeout:15000});
 await frame.locator('button#btnBook:visible').waitFor({state:'visible',timeout:45000});
 await frame.waitForFunction(({out,back})=>{
  const o=jsonOutFlts[out-1],r=back?jsonRetFlts[back-1]:null,info=UI_tabSearchFlights.flightInfo;
  const refs=o?.flightRPHList?.concat(r?.flightRPHList||[]);
  return Array.isArray(refs)&&Array.isArray(info)&&refs.length===info.length&&info.every(f=>refs.includes(f.flightRefNumber))
    && document.querySelector('input[name="depatureSelection"]:checked')?.value===String(out)
    && (!back || document.querySelector('input[name="returnSelection"]:checked')?.value===String(back));
 },{out:choice.out.row,back:choice.back?.row||null},{timeout:45000});
 return choice;
}
function flightPairs(times){return times.out.flatMap(out=>times.back.length?times.back.map(back=>({out,back})):[{out,back:null}]);}
module.exports={readFlightTimes,selectFlightTimes,flightPairs};
