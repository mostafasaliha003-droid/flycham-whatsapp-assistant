'use strict';
async function readFlightTimes(frame){
 return frame.evaluate(()=>{
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
  return {out:read('tblOutboundFlights','depatureSelection'),back:read('tblInboundFlights','returnSelection')};
 });
}
async function selectFlightTimes(frame,choice){
 const current=await readFlightTimes(frame);
 for(const [leg,name]of [['out','depatureSelection'],['back','returnSelection']]){
  const wanted=choice[leg],found=current[leg].find(f=>f.row===wanted.row);
  if(!found || ['flight','departure','arrival'].some(k=>found[k]!==wanted[k]))throw Error('FLIGHT_OPTION_CHANGED');
  await frame.locator('input[name="'+name+'"][value="'+wanted.row+'"]:visible').check({timeout:15000});
 }
 await frame.waitForFunction(()=>typeof jQuery!=='undefined'&&jQuery.active===0,null,{timeout:45000});
 const fq=frame.locator('#btnFQ:visible');if(await fq.count()===1)await fq.click({timeout:15000});
 await frame.locator('button#btnBook:visible').waitFor({state:'visible',timeout:45000});
 await frame.waitForFunction(({out,back})=>{
  const o=jsonOutFlts[out-1],r=jsonRetFlts[back-1],info=UI_tabSearchFlights.flightInfo;
  const refs=o?.flightRPHList?.concat(r?.flightRPHList||[]);
  return Array.isArray(refs)&&Array.isArray(info)&&refs.length===info.length&&info.every(f=>refs.includes(f.flightRefNumber))
    && document.querySelector('input[name="depatureSelection"]:checked')?.value===String(out)
    && document.querySelector('input[name="returnSelection"]:checked')?.value===String(back);
 },{out:choice.out.row,back:choice.back.row},{timeout:45000});
 return choice;
}
function flightPairs(times){return times.out.flatMap(out=>times.back.map(back=>({out,back})));}
module.exports={readFlightTimes,selectFlightTimes,flightPairs};
