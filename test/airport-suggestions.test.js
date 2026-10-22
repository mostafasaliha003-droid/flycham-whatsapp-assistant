'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { airportSuggestionAction } = require('../src/airport-suggestions');

function fixture(texts, { hidden = false, foreign = false } = {}) {
  let clicks = 0;
  const nodes = texts.map(text => ({ textContent: text, getClientRects: () => hidden ? [] : [1], parentElement: null, querySelectorAll: () => [], click: () => { clicks++; } }));
  const input = { getClientRects: () => [1], parentElement: null };
  const context = {
    location: { origin: foreign ? 'https://other.example' : 'https://agents.airarabia.com' },
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
