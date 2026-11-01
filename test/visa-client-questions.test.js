'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {QUESTION_CATALOG, questionFor, validateAnswer, requiredQuestions} = require('../src/visa-client-questions');

test('health and pledge choices accept only explicit booleans, with no default', () => {
  for (const field of ['previousNationality', 'travelledLastFiveYears', 'performUmrah', 'gccResident', 'priorGccDeportation', 'priorGccRuleViolation', 'health.hospitalizedOrEmergency', 'health.accidentDisability', 'health.congenitalCondition']) {
    assert.equal(validateAnswer(field, true), true);
    assert.equal(validateAnswer(field, false), false);
    assert.deepEqual(QUESTION_CATALOG[field].options.map(option => option.value), [true, false]);
    for (const value of [undefined, null, '', 0, 1, 'false', 'no', 'لا', 'unknown']) assert.throws(() => validateAnswer(field, value), {code: 'VISA_ANSWER_INVALID'});
  }
  const required = requiredQuestions({});
  assert(required.includes('health.hospitalizedOrEmergency'));
  assert(required.includes('health.accidentDisability'));
  assert(required.includes('health.congenitalCondition'));
});

test('question prompt explicitly identifies the applicant and returns isolated option data', () => {
  const question = questionFor('maritalStatus', {applicantIndex: 1, applicantName: 'سليم مثال'});
  assert.equal(question.applicantIndex, 1);
  assert.match(question.prompt, /رقم 2 \(سليم مثال\)/);
  assert.equal(question.field, 'maritalStatus');
  question.options[0].value = 'changed';
  assert.equal(QUESTION_CATALOG.maritalStatus.options[0].value, 'single');
  assert(Object.isFrozen(QUESTION_CATALOG['health.accidentDisability'].options[0]));
  for (const applicantIndex of [undefined, -1, 1.5, '1', 100]) assert.throws(() => questionFor('sex', {applicantIndex}), {code: 'VISA_APPLICANT_INDEX_INVALID'});
  assert.throws(() => questionFor('sex', {applicantIndex: 0, applicantName: 'Name\nOther'}), {code: 'VISA_APPLICANT_NAME_INVALID'});
});

test('affirmative nationality and travel answers require their details', () => {
  assert.deepEqual(requiredQuestions({previousNationality: true}, {requestedFields: ['previousNationality']}), ['previousNationalityDetails']);
  assert.deepEqual(requiredQuestions({previousNationality: false}, {requestedFields: ['previousNationality']}), []);
  assert.deepEqual(requiredQuestions({previousNationality: true, previousNationalityDetails: 'جنسية سابقة مؤكدة'}, {requestedFields: ['previousNationality']}), []);
  assert.deepEqual(requiredQuestions({travelledLastFiveYears: true}, {requestedFields: ['travelledLastFiveYears']}), ['travelHistory']);
  assert.deepEqual(requiredQuestions({travelledLastFiveYears: true, travelHistory: 'زيارة الأردن في 2024'}, {requestedFields: ['travelledLastFiveYears']}), []);
  assert.deepEqual(requiredQuestions({}, {requestedFields: ['previousNationality']}), ['previousNationality']);
  assert.deepEqual(requiredQuestions({}, {requestedFields: ['previousNationalityDetails']}), ['previousNationality']);
  assert.deepEqual(requiredQuestions({previousNationality: false}, {requestedFields: ['previousNationalityDetails']}), []);
});

test('required questions respect explicit false and independently validate nested health', () => {
  const fields = {health: {hospitalizedOrEmergency: false, accidentDisability: true}};
  assert.deepEqual(requiredQuestions(fields, {requestedFields: ['health.hospitalizedOrEmergency', 'health.accidentDisability', 'health.congenitalCondition']}), ['health.congenitalCondition']);
  assert.deepEqual(fields, {health: {hospitalizedOrEmergency: false, accidentDisability: true}});
  assert.deepEqual(requiredQuestions({sex: 'F'}, {requestedFields: ['sex', 'sex']}), []);
});

test('marital and sex choices reject facts outside the displayed options', () => {
  assert.equal(validateAnswer('maritalStatus', 'married'), 'married');
  assert.equal(validateAnswer('sex', 'X'), 'X');
  for (const value of ['unknown', 'MARRIED', true, null]) assert.throws(() => validateAnswer('maritalStatus', value), {code: 'VISA_ANSWER_INVALID'});
  assert.throws(() => validateAnswer('sex', 'unknown'), {code: 'VISA_ANSWER_INVALID'});
});

test('text answers are bounded and cannot silently stand for unknown facts', () => {
  assert.equal(validateAnswer('saudiAddress', '  فندق مثال، الرياض  '), 'فندق مثال، الرياض');
  assert.equal(validateAnswer('latinFirstName', 'Example'), 'Example');
  assert.equal(validateAnswer('arabicFirstName', 'مثال'), 'مثال');
  for (const value of ['', '  ', 'unknown', 'N/A', 'لا أعرف', 'لا اعرف', 'لا أدري', 'غير معروف', 'line\nsecond', 'x'.repeat(1501), null]) assert.throws(() => validateAnswer('saudiAddress', value), {code: 'VISA_ANSWER_INVALID'});
  assert.throws(() => validateAnswer('latinFirstName', 'مثال'), {code: 'VISA_ANSWER_INVALID'});
  assert.throws(() => validateAnswer('arabicFirstName', 'Example'), {code: 'VISA_ANSWER_INVALID'});
  assert.throws(() => validateAnswer('latinFirstName', '---'), {code: 'VISA_ANSWER_INVALID'});
});

test('requested document facts receive strict calendar and identifier validation', () => {
  assert.equal(validateAnswer('birthDate', '2000-02-29'), '2000-02-29');
  assert.equal(validateAnswer('birthDate', '0099-01-01'), '0099-01-01');
  for (const value of ['2023-02-29', '2024-02-30', '0000-01-01', '2024-13-01', '1/1/2000']) assert.throws(() => validateAnswer('birthDate', value), {code: 'VISA_ANSWER_INVALID'});
  assert.equal(validateAnswer('nationalityCode', 'TST'), 'TST');
  assert.throws(() => validateAnswer('nationalityCode', 'test'), {code: 'VISA_ANSWER_INVALID'});
  assert.equal(validateAnswer('passportNumber', 'T123456'), 'T123456');
  assert.throws(() => validateAnswer('passportNumber', 'T 123'), {code: 'VISA_ANSWER_INVALID'});
  assert.equal(validateAnswer('emiratesId', '784-2000-0000000-0'), '784200000000000');
});

test('unknown field names and malformed collections fail without using prototype properties', () => {
  for (const field of ['__proto__', 'constructor', 'health.other', undefined]) assert.throws(() => validateAnswer(field, false), {code: 'VISA_QUESTION_UNKNOWN'});
  assert.throws(() => requiredQuestions([], {}), {code: 'VISA_APPLICANT_FIELDS_INVALID'});
  assert.throws(() => requiredQuestions({}, {requestedFields: 'maritalStatus'}), {code: 'VISA_QUESTION_FIELDS_INVALID'});
  assert.throws(() => requiredQuestions({}, {requestedFields: ['unknown']}), {code: 'VISA_QUESTION_UNKNOWN'});
});

test('unknown accommodation stays explicit and contact questions require real formats',()=>{
 assert.equal(validateAnswer('saudiAddress','none'),'not_specified');
 assert.equal(validateAnswer('saudiAddress','غير محدد'),'not_specified');
 assert.equal(validateAnswer('applicationPhone','+971500000001'),'+971500000001');
 assert.throws(()=>validateAnswer('applicationPhone','0500000001'));
 assert.equal(validateAnswer('contactEmail','example@example.test'),'example@example.test');
 assert.throws(()=>validateAnswer('contactEmail','غير مؤكد'));
 const q=questionFor('arrivalPort',{applicantIndex:0});assert.equal(q.type,'choice');assert.ok(q.options.length>3);
 assert.deepEqual(requiredQuestions({arrivalPort:'other'},{requestedFields:['arrivalPort']}),['arrivalPortDetails']);
});
