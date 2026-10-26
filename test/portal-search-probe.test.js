'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { submitProbe } = require('../src/portal-search-probe');
const { airportCodeConfirmed } = require('../src/portal-search-probe');

test('confirms only an exact requested IATA token inside a supplier display value', () => {
  assert.equal(airportCodeConfirmed('SHJ - Sharjah', 'SHJ'), true);
  assert.equal(airportCodeConfirmed('Sharjah (SHJ)', 'SHJ'), true);
  assert.equal(airportCodeConfirmed('SHJ Airport', 'SHJ'), true);
  assert.equal(airportCodeConfirmed('OTHER', 'SHJ'), false);
  assert.equal(airportCodeConfirmed('XSHJX', 'SHJ'), false);
  assert.equal(airportCodeConfirmed('SHJ / DAM', 'SHJ'), false);
});

function fixture({ wrongAirport = false, missingOneWay = false, missingOption = false, defaultReturn = false } = {}) {
  const calls = [];
  const values = {};
  let optionReads = 0;
  const frame = {
    evaluate: async (fn, args) => {
      if (!args) return missingOneWay ? -1 : 0;
      if (args.operation === 'input') return { status: 'INPUT_READY' };
      if (args.operation === 'default-return') return defaultReturn;
      if (args.operation === 'inspect') return { status: 'READY' };
      if (args.operation === 'click') return { status: 'CLICKED' };
      if (args.pattern) { optionReads++; return missingOption ? null : args.id === 'selectedCurrency' ? 'AED' : 'observed-option'; }
      return true;
    },
    evaluateHandle: async () => ({ asElement: () => ({ click: async () => calls.push(['pointer-click', 'suggestion']) }), dispose: async () => {} }),
    locator: selector => {
      const field = {
        fill: async value => { values[selector] = value; calls.push(['fill', selector]); },
        pressSequentially: async value => { values[selector] = value; calls.push(['type', selector]); },
        press: async key => calls.push(['key', selector, key]),
        nth: () => field,
        check: async () => calls.push(['check', selector]),
        selectOption: async () => calls.push(['select', selector]),
        inputValue: async () => wrongAirport ? 'OTHER' : selector === '#fromAirport' ? 'SHJ' : 'DAM',
        click: async () => calls.push(['click', selector]),
        filter: () => field,
        first: () => field,
        waitFor: async () => {},
        count: async () => 1,
      };
      return field;
    },
  };
  return { frame, calls, values, optionReads: () => optionReads };
}
const config = { origin: 'SHJ', destination: 'DAM', departureDate: '11/11/2026' };

test('customer return search uses the exact requested return date without a synthetic fallback',async()=>{
  const f=fixture({defaultReturn:true});
  const result=await submitProbe(f.frame,{...config,requestTripType:'round_trip',requestedReturnDate:'29/11/2026'});
  assert.equal(result.tripKind,'return');assert.equal(f.values['#returnDate'],'29/11/2026');
  const bad=fixture({defaultReturn:false});
  await assert.rejects(submitProbe(bad.frame,{...config,requestTripType:'round_trip',requestedReturnDate:'29/11/2026'}));
  assert.ok(!bad.calls.some(([action,selector])=>action==='click'&&selector.includes('btnSearch')));
});
test('customer one-way search clears the optional return field instead of fabricating a seven-day return',async()=>{
 const f=fixture({missingOneWay:true,defaultReturn:true});const result=await submitProbe(f.frame,{...config,requestTripType:'one_way'});
 assert.equal(result.tripKind,'one-way');assert.equal(f.values['#returnDate'],'');
});

test('probe fills observed text passenger counts and clicks only the search control', async () => {
  const f = fixture();
  assert.equal((await submitProbe(f.frame, config)).submitted, true);
  assert.deepEqual([f.values['#adultCount'], f.values['#childCount'], f.values['#infantCount']], ['1', '0', '0']);
  assert.equal(f.optionReads(), 4);
  assert.ok(!f.calls.some(([action, selector]) => action === 'select' && /Count/.test(selector)));
  assert.ok(f.calls.some(([action, selector]) => action === 'click' && selector === 'input#btnSearch[type="button"]:visible'));
  assert.ok(!f.calls.some(([, selector]) => /btnBook|passenger|payment/i.test(selector)));
});

test('probe never searches if the airport, one-way control or supplier options are unconfirmed', async () => {
  for (const options of [{ wrongAirport: true }, { missingOneWay: true }, { missingOption: true }]) {
    const f = fixture(options);
    await assert.rejects(submitProbe(f.frame, config), /NOT_CONFIRMED/);
    assert.ok(!f.calls.some(([action, selector]) => action === 'click' && selector.includes('btnSearch')));
  }
});

test('probe rejects unsupported routes before interacting with the portal', async () => {
  const f = fixture();
  await assert.rejects(submitProbe(f.frame, { ...config, origin: 'OTHER' }), /UNSUPPORTED/);
  assert.equal(f.calls.length, 0);
});

const vm = require('node:vm');
function radioDOM(labels) {
  const radios = labels.map(() => ({ id: 'searchType', disabled: false, labels: [], getAttribute: () => null, closest: () => null, form: {} }));
  const parent = { closest: () => null, getClientRects: () => [1] };
  return {
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4 },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    document: {
      body: {},
      querySelectorAll: () => radios,
      createTreeWalker: () => {
        let position = -1, origin;
        return {
          get currentNode() { return position === -1 ? origin : position === 0 ? { nodeType: 3, parentElement: parent, textContent: labels[radios.indexOf(origin)] } : { nodeType: 1, tagName: 'INPUT' }; },
          set currentNode(node) { origin = node; },
          nextNode() { position++; return position < 2; },
        };
      },
    },
  };
}

test('reads a hyphenated loose radio label despite duplicate supplier IDs', async () => {
  const f = fixture();
  const original = f.frame.evaluate;
  f.frame.evaluate = async (fn, args) => args ? original(fn, args) : vm.runInNewContext(`(${fn.toString()})()`, radioDOM(['Round Trip', 'Multi City', 'One-way']));
  const locator = f.frame.locator;
  let checkedIndex;
  f.frame.locator = selector => {
    const field = locator(selector);
    const nth = field.nth;
    field.nth = index => { checkedIndex = index; return nth(index); };
    return field;
  };
  await submitProbe(f.frame, config);
  assert.equal(checkedIndex, 2);
});

test('ambiguous adjacent one-way labels stop without a search', async () => {
  const f = fixture();
  const original = f.frame.evaluate;
  f.frame.evaluate = async (fn, args) => args ? original(fn, args) : vm.runInNewContext(`(${fn.toString()})()`, radioDOM(['One-way', 'Multi City', 'One Way']));
  await assert.rejects(submitProbe(f.frame, config), /ONE_WAY_CONTROL_NOT_CONFIRMED/);
  assert.equal(f.calls.length, 0);
});

test('selects the live Search G9 label and actual supplier enum AA', async () => {
  const f = fixture();
  const original = f.frame.evaluate;
  f.frame.evaluate = async (fn, args) => args?.id === 'selSearchOptions' && args.pattern
    ? vm.runInNewContext(`(${fn.toString()})(args)`, { args, location:{origin:'https://agents.airarabia.com'},getComputedStyle:()=>({display:'block',visibility:'visible'}),document: {querySelectorAll:()=>[{ tagName: 'SELECT',getClientRects:()=>[1],options: [{ value: 'AA', textContent: 'Search G9' }, { value: 'INT', textContent: 'Search All' }] }]} })
    : original(fn, args);
  const locator = f.frame.locator;
  let selected;
  f.frame.locator = selector => { const field = locator(selector); if (selector === '#selSearchOptions') field.selectOption = async value => { selected = value; }; return field; };
  await submitProbe(f.frame, config);
  assert.equal(selected, 'AA');
});


test('preserves a confirmed default return mode and enters a date seven days later', async () => {
  const f = fixture({ missingOneWay: true, defaultReturn: true });
  const result = await submitProbe(f.frame, { ...config, departureDate: '28/12/2026' });
  assert.equal(result.tripKind, 'return');
  assert.equal(f.values['#returnDate'], '04/01/2027');
  assert.ok(!f.calls.some(([operation]) => operation === 'check'));
});


test('airport confirmation follows a real pointer click and disposes its element handle', async () => {
  const { chooseAirport } = require('../src/portal-search-probe');
  let hidden = '', disposed = 0, pointerClicks = 0;
  const frame = {
    locator: selector => ({ fill: async () => {}, pressSequentially: async () => {}, press: async () => {}, inputValue: async () => hidden }),
    evaluate: async (fn, args) => ({ status: args.operation === 'input' ? 'INPUT_READY' : 'READY' }),
    evaluateHandle: async (fn, args) => {
      assert.equal(args.operation, 'resolve');
      return { asElement: () => ({ click: async () => { pointerClicks++; hidden = 'SHJ'; } }), dispose: async () => { disposed++; } };
    },
  };
  await chooseAirport(frame, 'fAirport', 'fromAirport', 'SHJ', { lookupMs: 0 });
  assert.equal(pointerClicks, 1); assert.equal(disposed, 1);
});

test('airport confirmation accepts a formatted supplier value only after the pointer click', async () => {
  const { chooseAirport } = require('../src/portal-search-probe');
  let hidden = '', pointerClicks = 0;
  const frame = {
    locator: selector => ({ fill: async () => {}, pressSequentially: async () => {}, press: async () => {}, inputValue: async () => hidden }),
    evaluate: async (fn, args) => ({ status: args.operation === 'input' ? 'INPUT_READY' : 'READY' }),
    evaluateHandle: async () => ({ asElement: () => ({ click: async () => { pointerClicks++; hidden = 'SHJ - Sharjah'; } }), dispose: async () => {} }),
  };
  await chooseAirport(frame, 'fAirport', 'fromAirport', 'SHJ', { lookupMs: 0 });
  assert.equal(pointerClicks, 1);
});

test('airport selection verifies the trusted input before typing', async () => {
  const { chooseAirport } = require('../src/portal-search-probe');
  let fills = 0;
  const frame = { evaluate: async () => ({ status: 'UNTRUSTED' }), locator: () => ({ fill: async () => { fills++; } }) };
  await assert.rejects(chooseAirport(frame, 'fAirport', 'fromAirport', 'SHJ', { lookupMs: 0 }), /AIRPORT_SELECTION_NOT_CONFIRMED/);
  assert.equal(fills, 0);
});

test('airport selection leaves the field normally when the supplier commits on blur', async () => {
  const { chooseAirport } = require('../src/portal-search-probe');
  let hidden = '', tabs = 0, clicks = 0;
  const frame = {
    evaluate: async (fn, args) => ({ status: args.operation === 'input' ? 'INPUT_READY' : 'READY' }),
    locator: () => ({ fill: async () => {}, pressSequentially: async () => {}, inputValue: async () => hidden, press: async key => { assert.equal(key, 'Tab'); tabs++; hidden = 'SHJ'; } }),
    evaluateHandle: async () => ({ asElement: () => ({ click: async () => { clicks++; } }), dispose: async () => {} }),
  };
  await chooseAirport(frame, 'fAirport', 'fromAirport', 'SHJ', { lookupMs: 0 });
  assert.equal(tabs, 1); assert.equal(clicks, 1);
});

test('an empty code selection retries the city once without writing the supplier field', async () => {
  const { chooseAirport } = require('../src/portal-search-probe');
  let hidden = '', query = '', clicks = 0;
  const typed = [];
  const frame = {
    evaluate: async (fn, args) => ({ status: args.operation === 'input' ? 'INPUT_READY' : 'READY' }),
    locator: selector => ({ fill: async () => { assert.equal(selector, '#fAirport'); }, pressSequentially: async value => { query = value; typed.push(value); }, inputValue: async () => hidden, press: async key => assert.equal(key, 'Tab') }),
    evaluateHandle: async () => ({ asElement: () => ({ click: async () => { clicks++; if (query === 'Sharjah') hidden = 'SHJ'; } }), dispose: async () => {} }),
  };
  await chooseAirport(frame, 'fAirport', 'fromAirport', 'SHJ', { lookupMs: 0 });
  assert.deepEqual(typed, ['SHJ', 'Sharjah']); assert.equal(clicks, 2);
});

test('a conflicting supplier airport never retries or searches', async () => {
  const { chooseAirport } = require('../src/portal-search-probe');
  const typed = [];
  const frame = {
    evaluate: async (fn, args) => ({ status: args.operation === 'input' ? 'INPUT_READY' : 'READY' }),
    locator: () => ({ fill: async () => {}, pressSequentially: async value => typed.push(value), inputValue: async () => 'DAM', press: async () => {} }),
    evaluateHandle: async () => ({ asElement: () => ({ click: async () => {} }), dispose: async () => {} }),
  };
  await assert.rejects(chooseAirport(frame, 'fAirport', 'fromAirport', 'SHJ', { lookupMs: 0 }), /AIRPORT_SELECTION_NOT_CONFIRMED/);
  assert.deepEqual(typed, ['SHJ']);
});

test('FlyCham accepts its visible search control without requiring AirArabia input type',async()=>{
 const {clickSearchControl}=require('../src/portal-search-probe');let clicks=0;const control={count:async()=>1,isVisible:async()=>true,click:async()=>clicks++};
 await clickSearchControl({locator:selector=>{assert.match(selector,/button#btnSearch/);return control;}},'flycham');assert.equal(clicks,1);
});
test('ambiguous FlyCham search controls never click or fall through to reservation actions',async()=>{
 const {clickSearchControl}=require('../src/portal-search-probe');await assert.rejects(clickSearchControl({locator:()=>({count:async()=>2}),getByRole:()=>{throw Error('must not fall through');}},'flycham'),/SEARCH_CONTROL_UNCONFIRMED/);
});
