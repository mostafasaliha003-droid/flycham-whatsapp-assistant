'use strict';
const {chooseAirport}=require('./portal-search-probe');

// Bounded startup capability check before consuming any customer job. Only
// airport selection is exercised; never Search, passengers or reservations.
// Fixed event codes only: no page text, credentials or customer data in logs.
async function diagnoseFlyChamAirports(adapter) {
  const origin='https://reservations.flycham.com';
  const frame=await adapter.openSearchForm();
  for(const code of ['DXB','DWC','AUH','SHJ']){
    try{
      await chooseAirport(frame,'fAirport','fromAirport',code,{origin,lookupMs:2000});
      adapter.report('FLYCHAM_ORIGIN_SELECTION_CONFIRMED_'+code);
    }catch{
      adapter.report('FLYCHAM_ORIGIN_SELECTION_UNCONFIRMED_'+code);
    }
  }
  await adapter.openSearchForm();
}
module.exports={diagnoseFlyChamAirports};
