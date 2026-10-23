'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { airportSuggestionAction } = require('../src/airport-suggestions');

function fixture(texts, { hidden = false, foreign = false, origin='https://agents.airarabia.com' } = {}) {
  let clicks = 0;
  const nodes = texts.map(text => ({ textContent: text, getClientRects: () => hidden ? [] : [1], parentElement: null, querySelectorAll: () => [], click: () => { clicks++; } }));
  const input = { getClientRects: () => [1], parentElement: null };
  const context = {
    location: { origin: foreign ? 'https://other.example' : origin },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    document: { querySelectorAll: selector => selector.startsWith('[id=') ? [input] : nodes },
  };
  return { call: args => vm.runInNewContext(`(${airportSuggestionAction.toString()})(args)`, { ...context, args }), clicks: () => clicks };
}

test('accepts supplier airport-name labels without depending on a CSS widget', () => {
  for (const text of ['Sharjah', 'SHJ - Sharjah', 'Sharjah (SHJ)', 'Sharjah International Airport (SHJ), UAE']) {
    const f = fixture([text]);
    assert.equal(f.call({ inputId: 'fAirport', code: 'SHJ' }).status, 'READY');
    assert.equal(f.clicks(), 0);
    assert.equal(f.call({ inputId: 'fAirport', code: 'SHJ', operation: 'resolve' }).textContent, text);
    assert.equal(f.clicks(), 0);
  }
});

test('rejects unrelated, ambiguous, hidden and foreign suggestions without clicking', () => {
  for (const [texts, options] of [
    [['Sharjah cancel booking'], {}],
    [['Flights to SHJ'], {}],
    [['Sharjah', 'SHJ - Sharjah'], {}],
    [['Sharjah'], { hidden: true }],
    [['Sharjah'], { foreign: true }],
  ]) {
    const f = fixture(texts, options);
    assert.ok(f.call({ inputId: 'fAirport', code: 'SHJ', operation: 'resolve' }).status);
    assert.equal(f.clicks(), 0);
  }
});

test('treats city and IATA spans inside one list option as one suggestion', () => {
  let clicks = 0;
  const base = { getClientRects: () => [1], parentElement: null };
  const option = { ...base, textContent: 'Sharjah (SHJ)', click: () => { clicks++; } };
  const city = { ...base, textContent: 'Sharjah', querySelectorAll: () => [], closest: () => option };
  const code = { ...base, textContent: '(SHJ)', querySelectorAll: () => [], closest: () => option };
  option.closest = () => option;
  option.querySelectorAll = () => [city, code];
  const result = vm.runInNewContext(`(${airportSuggestionAction.toString()})(args)`, {
    args: { inputId: 'fAirport', code: 'SHJ', operation: 'resolve' },
    location: { origin: 'https://agents.airarabia.com' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    document: { querySelectorAll: selector => selector.startsWith('[id=') ? [base] : [option, city, code] },
  });
  assert.equal(result, option);
  assert.equal(clicks, 0);
});

test('FlyCham suggestions are allowed only when the caller and page both name the trusted FlyCham origin',()=>{
 const origin='https://reservations.flycham.com',f=fixture(['Sharjah'],{origin});
 assert.equal(f.call({inputId:'fAirport',code:'SHJ',origin}).status,'READY');assert.equal(f.call({inputId:'fAirport',code:'SHJ'}).status,'UNTRUSTED');
 assert.equal(f.call({inputId:'fAirport',code:'SHJ',origin:'https://other.example'}).status,'UNTRUSTED');
});

test('does not promote a dropdown label to a layout cell containing the airport input', () => {
  const base = { getClientRects: () => [1], parentElement: null, querySelectorAll: () => [] };
  const input = { ...base };
  const cell = { ...base, textContent: 'Sharjah (SHJ)', querySelector: () => input };
  const option = { ...base, textContent: 'Sharjah (SHJ)', closest: () => cell };
  const result = vm.runInNewContext(`(${airportSuggestionAction.toString()})(args)`, {
    args: { inputId: 'fAirport', code: 'SHJ', operation: 'resolve' },
    location: { origin: 'https://agents.airarabia.com' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    document: { querySelectorAll: selector => selector.startsWith('[id=') ? [input] : [cell, option] },
  });
  assert.equal(result, option);
});

test('uses only suggestions inside the active airport input owned dropdown', () => {
  const base = { getClientRects: () => [1], parentElement: null, querySelectorAll: () => [] };
  const input = { ...base, getAttribute: name => name === 'aria-controls' ? 'origin-options' : null };
  const intended = { ...base, textContent: 'Sharjah (SHJ)' };
  const unrelated = { ...base, textContent: 'Sharjah (SHJ)' };
  const menu = { ...base, textContent: 'Sharjah (SHJ)', querySelectorAll: () => [intended] };
  const result = vm.runInNewContext(`(${airportSuggestionAction.toString()})(args)`, {
    args: { inputId: 'fAirport', code: 'SHJ', operation: 'resolve' },
    location: { origin: 'https://agents.airarabia.com' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    document: { querySelectorAll: selector => selector === '[id="fAirport"]' ? [input] : selector === '[id="origin-options"]' ? [menu] : [menu, intended, unrelated] },
  });
  assert.equal(result, intended);
});

test('an owned dropdown with duplicate identifiers cannot fall back to unrelated page labels', () => {
  const base = { getClientRects: () => [1], parentElement: null };
  const input = { ...base, getAttribute: name => name === 'aria-controls' ? 'origin-options' : null };
  const result = vm.runInNewContext(`(${airportSuggestionAction.toString()})(args)`, {
    args: { inputId: 'fAirport', code: 'SHJ', operation: 'resolve' },
    location: { origin: 'https://agents.airarabia.com' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    document: { querySelectorAll: selector => selector === '[id="fAirport"]' ? [input] : [base, base] },
  });
  assert.equal(result.status, 'INPUT_UNAVAILABLE');
});
test('Aleppo selects only a unique observed airport suggestion on either supplier',()=>{
 for(const origin of ['https://agents.airarabia.com','https://reservations.flycham.com']){
  const f=fixture(['Aleppo International Airport (ALP), Syria'],{origin});assert.equal(f.call({inputId:'tAirport',code:'ALP',origin}).status,'READY');assert.equal(f.call({inputId:'tAirport',code:'ALP',origin,operation:'resolve'}).textContent,'Aleppo International Airport (ALP), Syria');
  const wrong=fixture(['Damascus (DAM)'],{origin});assert.equal(wrong.call({inputId:'tAirport',code:'ALP',origin}).status,'NONE');
 }
});
