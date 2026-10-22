'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { scanAncillaryCatalogs, summarizeCatalog, foodKind, checkedWeight } = require('../src/portal-ancillary-catalogs');

test('never treats no-meal or beverages as free food; unknown food remains unconfirmed', () => {
  for (const name of ['No Meal', 'No meal - not required', 'Without food', 'بدون وجبة']) assert.equal(foodKind(name), 'none');
  for (const name of ['Water', 'Mineral water 500 ml', 'Tea', 'Coffee']) assert.equal(foodKind(name), 'drink');
  assert.equal(foodKind('Chicken Biryani'), 'food');
  assert.equal(foodKind('Special offer'), 'unconfirmed');
  const result = summarizeCatalog({ currency:'AED', expected:3, coveredSegments:[0], options:[
    { name:'No Meal', priceText:'Free', available:true }, { name:'Water', priceText:'0', available:true },
    { name:'Chicken Rice', priceText:'25.00', available:true },
  ] }, 'meal');
  assert.equal(result.cheapest.price.amount, 25);
  assert.equal(result.customerQuoteReady, false);
});

test('unknown prices, inventory and weight alternatives never become complete quotes', () => {
  for (const option of [{ name:'20 KG', priceText:'unknown', available:true }, { name:'20 KG', priceText:'50', available:null }, { name:'2 Pieces x 23 KG', priceText:'50', available:true }]) {
    const result = summarizeCatalog({ currency:'AED', expected:1, coveredSegments:[0], options:[option] }, 'baggage');
    assert.equal(result.complete, false); assert.equal(result.cheapest, null);
  }
  assert.equal(checkedWeight('Baggage 30 KG'), 30);
  assert.equal(checkedWeight('20 KG + 10 KG'), null);
  assert.equal(checkedWeight('No checked baggage'), 0);
});

function fixture({ sharedBaggage = false, duplicatePriceRow = false, wrongPassenger = false } = {}) {
  const calls = [], events = [];
  const state = {
    location:{ origin:'https://agents.airarabia.com' }, UI_commonSystem:{ strPGMode:'' }, DATA_ResPro:{ initialParams:{ baseCurrencyCode:'AED' } },
    UI_tabAnci:{ currAnciSrv:'SEAT', currSegRow:0, dataStatus:{}, jsonFareQuoteSummary:{ currency:'AED' }, focMealEnabled:false },
    jsonPaxAdults:[{ displayAdultFirstName:wrongPassenger ? 'REAL' : 'TEST', displayAdultLastName:'QUOTE' }], jsonPaxInfants:[],
    jsAnciSeg:[{ fltRefNo:'seg0', flightNumber:'G9363' },{ fltRefNo:'seg1', flightNumber:'G9434' }],
    jsMealList:[], jsBaggageList:[], jsMealModel:[], jsBaggageModel:[],
    getBaggageONDGrpId:() => sharedBaggage ? 'one-group' : null,
    getComputedStyle:() => ({ display:'block' }),
  };
  const meals = [0,1].map(index => [
    { mealName:'Chicken Rice', mealCharge:index ? '20.00' : 'Free', availableMeals:15 },
    { mealName:'No Meal', mealCharge:'Free', availableMeals:15 },
    { mealName:'Water', mealCharge:'Free', availableMeals:15 },
  ]);
  const baggage = [0,1].map(() => [
    { baggageDisplayName:'20 KG', baggageCharge:'Free', availableQty:-1 },
    { baggageDisplayName:'30 KG', baggageCharge:'50.00', availableQty:-1 },
    { baggageDisplayName:'40 KG', baggageCharge:'80.00', availableQty:-1 },
  ]);
  state.jsMealModel = meals.map(items => ({ meals:items }));
  state.jsBaggageModel = baggage.map(items => ({ baggages:items }));
  const segments = () => (sharedBaggage && state.UI_tabAnci.currAnciSrv === 'BAGGAGE' ? [0] : [0,1]).map(index => ({
    id:'tdAnciSeg_' + index, classList:{ contains:name => name === 'cursorPointer' },
  }));
  const table = id => {
    const meal = id === 'tblAnciMealBundle' && state.UI_tabAnci.currAnciSrv === 'MEAL';
    const bag = id === 'tblAnciBaggage' && state.UI_tabAnci.currAnciSrv === 'BAGGAGE';
    if (!meal && !bag) return null;
    let items = meal ? meals[state.UI_tabAnci.currSegRow] : baggage[state.UI_tabAnci.currSegRow];
    if (duplicatePriceRow) items = items.concat(items[0]);
    return { getClientRects:() => [1], querySelectorAll:() => items.map(item => ({ querySelector:selector => ({
      textContent:selector.includes(meal ? '_mealName' : '_baggageDisplayName') ? item[meal ? 'mealName' : 'baggageDisplayName'] : item[meal ? 'mealCharge' : 'baggageCharge'],
    }) })) };
  };
  state.document = { querySelectorAll:segments, getElementById:table };
  function setLists() {
    const index = state.UI_tabAnci.currSegRow;
    state.jsMealList = meals[index].map((m,i) => ({ ...m, mmSGI:index, mmI:i }));
    state.jsBaggageList = baggage[index].map((m,i) => ({ ...m, mmSGI:index, mmI:i }));
  }
  const evaluate = (fn,arg) => vm.runInNewContext('(' + fn.toString() + ')(arg)', { ...state, arg });
  const page = { route:async (pattern,guard) => { page.guard=guard; }, unroute:async () => { page.removed=true; } };
  const frame = {
    evaluate:async (fn,arg) => JSON.parse(JSON.stringify(evaluate(fn,arg))),
    waitForFunction:async (fn,arg) => assert.equal(evaluate(fn,arg), true),
    locator:selector => ({ count:async () => 1, click:async () => {
      calls.push(selector);
      if (selector === '#imgTab_1:visible' || selector === '#imgTab_5:visible') {
        const meal = selector === '#imgTab_1:visible';
        state.UI_tabAnci.currAnciSrv = meal ? 'MEAL' : 'BAGGAGE';
        state.UI_tabAnci.dataStatus[meal ? 'meal' : 'baggage'] = true;
        state.UI_tabAnci.currSegRow = 0;
        await page.guard({ request:() => ({ url:() => 'https://agents.airarabia.com/xbe/private/' + (meal ? 'anciMeal.action' : 'anciBaggage.action'), method:() => 'POST', resourceType:() => 'xhr' }), abort:async () => assert.fail('catalog blocked'), continue:async () => {} });
      } else if (/^#tdAnciSeg_\d+$/.test(selector)) state.UI_tabAnci.currSegRow=Number(selector.split('_').pop());
      else assert.fail('Service selection or confirmation clicked: ' + selector);
      setLists();
    } }),
  };
  return { page, frame, calls, events, report:e => events.push(e) };
}

test('reads all meal and weight choices on both legs without selecting services', async () => {
  const f=fixture();
  const result=await scanAncillaryCatalogs(f.frame,f.page,f.report);
  assert.equal(result.complete,true);
  assert.equal(result.customerQuoteReady,false);
  assert.deepEqual(result.results[0].catalogs.map(c => c.cheapest.price.amount),[0,20]);
  assert.deepEqual(result.results[1].catalogs[0].options.map(o => o.checkedWeightKg),[20,30,40]);
  assert.ok(result.results[1].catalogs.every(c => c.options.every(o => o.handWeightKg === null)));
  assert.ok(f.calls.every(s => /imgTab_[15]|tdAnciSeg_/.test(s)));
  assert.equal(f.page.removed,true);
  assert.ok(!f.events.join('').includes('QUOTE'));
});

test('shared baggage group covers both legs once; duplicate display rows block price verification', async () => {
  const group=fixture({ sharedBaggage:true });
  const result=await scanAncillaryCatalogs(group.frame,group.page,group.report);
  assert.equal(result.complete,true);
  assert.equal(result.results[1].catalogs.length,1);
  assert.deepEqual(result.results[1].catalogs[0].coveredSegments,[0,1]);
  const partial=fixture({ duplicatePriceRow:true });
  const incomplete=await scanAncillaryCatalogs(partial.frame,partial.page,partial.report);
  assert.equal(incomplete.complete,false);
});

test('refuses real passengers before catalog navigation', async () => {
  const f=fixture({ wrongPassenger:true });
  await assert.rejects(scanAncillaryCatalogs(f.frame,f.page,f.report),/SCOPE_NOT_CONFIRMED/);
  assert.equal(f.calls.length,0);
});
