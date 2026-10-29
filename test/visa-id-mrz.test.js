'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {parseTD1MRZ, matchesPrintedEmiratesId, resolvePrintedDate} = require('../src/visa-id-mrz');

function digit(value) {
  return String([...value].reduce((sum, c, i) => sum + (c === '<' ? 0 : /[0-9]/.test(c) ? Number(c) : c.charCodeAt(0) - 55) * [7, 3, 1][i % 3], 0) % 10);
}
function td1({number='Z12345678', birth='900115', expiry='310308', issuer='ARE', nationality='UTO', sex='F', optional='784199012345671', optionalSecond='<'.repeat(11), name='EXAMPLE<<SYNTHETIC<PARENT'}={}) {
  const padded=number.padEnd(9, '<');
  const first='IL'+issuer+padded+digit(padded)+optional.padEnd(15, '<');
  const body=birth+digit(birth)+sex+expiry+digit(expiry)+nationality+optionalSecond;
  return [first, body+digit(first.slice(5)+body.slice(0,7)+body.slice(8,15)+body.slice(18,29)), name.padEnd(30,'<')];
}
function alter(lines, line, position, value) {
  const copy=[...lines]; copy[line]=copy[line].slice(0,position)+value+copy[line].slice(position+1); return copy;
}

test('TD1 validates all four checks and retains raw dates without deciding centuries or government fields', () => {
  const result=parseTD1MRZ(td1());
  assert.equal(result.ok,true);
  assert.equal(result.format,'TD1');
  assert.equal(Object.keys(result.checks).length,4);
  assert.equal(Object.values(result.checks).every(check=>check.ok),true);
  assert.equal(result.fields.birthDateRaw,'900115');
  assert.equal(result.fields.expiryDateRaw,'310308');
  assert.equal(result.fields.birthDate,undefined);
  assert.equal(result.fields.residenceExpiry,undefined);
  assert.equal(result.fields.emiratesId,undefined);
  assert.equal(result.fields.latinNames.family,'EXAMPLE');
  assert.equal(result.fields.latinNames.givenNames,'SYNTHETIC PARENT');
  assert.equal(result.fields.latinFatherName,undefined);
  assert.equal(result.fields.documentReviewed,false);
  assert.equal(parseTD1MRZ(td1().join('\r\n')).ok,true);
});

test('TD1 agrees with the independent fictional Utopia vector in ICAO Part 5 Appendix A', () => {
  const result=parseTD1MRZ(['I<UTOD231458907<<<<<<<<<<<<<<<','7408122F1204159UTO<<<<<<<<<<<6','ERIKSSON<<ANNA<MARIA<<<<<<<<<<']);
  assert.equal(result.ok,true);
  assert.equal(result.fields.documentNumber,'D23145890');
  assert.equal(result.fields.birthDateRaw,'740812');
  assert.equal(result.fields.expiryDateRaw,'120415');
  assert.equal(result.checks.composite.actual,'6');
});

test('TD1 independently rejects every altered check digit', () => {
  for (const [line,position,name] of [[0,14,'documentNumber'],[1,6,'birthDate'],[1,14,'expiryDate'],[1,29,'composite']]) {
    const lines=td1(), changed=String((Number(lines[line][position])+1)%10);
    const result=parseTD1MRZ(alter(lines,line,position,changed));
    assert.equal(result.ok,false);
    assert.equal(result.checks[name].ok,false);
  }
});

test('TD1 does not pad, trim, repair, normalize, or accept extended document numbers', () => {
  const lines=td1();
  for (const candidate of [[lines[0].slice(1),...lines.slice(1)], [...lines,''], lines.map(x=>x.toLowerCase()), [lines[0]+' ',...lines.slice(1)], null]) assert.equal(parseTD1MRZ(candidate).ok,false);
  assert.equal(parseTD1MRZ(alter(lines,0,14,'<')).issues.some(x=>x.code==='unsupported_extended_number'),true);
  assert.equal(parseTD1MRZ(alter(lines,0,5,'O')).ok,false);
  assert.equal(parseTD1MRZ(alter(lines,1,0,'O')).ok,false);
});

test('TD1 rejects checked but invalid calendar dates, names, sex, types and country zones', () => {
  for (const options of [{birth:'900231'},{expiry:'310229'},{expiry:'311301'},{birth:'900000'},{sex:'X'},{issuer:'A12'},{nationality:'<TO'},{name:'EXAMPLE<<SYNTHETIC2'},{name:'EXAMPLE<<SYNTHETIC<<PARENT'}]) assert.equal(parseTD1MRZ(td1(options)).ok,false);
  assert.equal(parseTD1MRZ(td1({birth:'000229'})).ok,true);
  for (const type of ['PV','IV','AI','AC','<L','11']) {
    const lines=td1(); lines[0]=type+lines[0].slice(2); assert.equal(parseTD1MRZ(lines).ok,false);
  }
  assert.equal(parseTD1MRZ(td1({number:'Z12'})).fields.documentNumber,'Z12');
});

test('TD1 marks terminal name truncation so callers cannot treat a prefix as exact full-name evidence', () => {
  const name='EXAMPLE<<SYNTHETIC<PERSON<ABCD';
  assert.equal(name.length,30);
  const result=parseTD1MRZ(td1({name}));
  assert.equal(result.ok,true);
  assert.equal(result.fields.latinNames.truncated,true);
});

test('optional UAE data is an ID anchor only with a separately printed complete exact ID and every check', () => {
  const parsed=parseTD1MRZ(td1());
  assert.equal(matchesPrintedEmiratesId(parsed,'784-1990-1234567-1'),true);
  assert.equal(matchesPrintedEmiratesId(parsed,'784199012345671'),true);
  for (const value of [undefined,null,'199012345671','784-1990-123456-1','784199012345672',' 784199012345671','٧٨٤١٩٩٠١٢٣٤٥٦٧١']) assert.equal(matchesPrintedEmiratesId(parsed,value),false);
  assert.equal(matchesPrintedEmiratesId(parseTD1MRZ(td1({issuer:'UTO'})),'784199012345671'),false);
  assert.equal(matchesPrintedEmiratesId(parseTD1MRZ(td1({optional:'<'.repeat(15)})),'784199012345671'),false);
  const lines=td1();
  assert.equal(matchesPrintedEmiratesId(parseTD1MRZ(alter(lines,1,29,String((Number(lines[1][29])+1)%10))),'784199012345671'),false);
});

test('date resolver chooses the sole real full-year candidate matching checked YYMMDD and invents no century', () => {
  assert.equal(resolvePrintedDate('08/03/2031','310308'),'2031-03-08');
  assert.equal(resolvePrintedDate('08/03/2031','310803'),'2031-08-03');
  assert.equal(resolvePrintedDate('13/03/2031','310313'),'2031-03-13');
  assert.equal(resolvePrintedDate('07/07/2031','310707'),'2031-07-07');
  assert.equal(resolvePrintedDate('29/02/2000','000229'),'2000-02-29');
  for (const [raw,mrz] of [['08/03/2031','310309'],['31/02/2031','310231'],['29/02/1900','000229'],['08/03/31','310308'],['2031-03-08','310308'],['08/03/2031','31030O'],['08/03/0000','000308']]) assert.equal(resolvePrintedDate(raw,mrz),null);
  assert.equal(resolvePrintedDate('08/03/1931','310308'),'1931-03-08');
});
