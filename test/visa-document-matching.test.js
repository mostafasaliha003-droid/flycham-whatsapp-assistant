'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {reconcileDocumentEvidence, DOCUMENT_CONFIDENCE_THRESHOLD} = require('../src/visa-document-matching');

const DAY = '2026-10-28';
const IDS = {passport:'12345678-1234-4321-abcd-123456789001', front:'12345678-1234-4321-abcd-123456789002', back:'12345678-1234-4321-abcd-123456789003', portrait:'12345678-1234-4321-abcd-123456789004', passport2:'12345678-1234-4321-abcd-123456789005', front2:'12345678-1234-4321-abcd-123456789006'};
function digit(value) { return String([...value].reduce((sum, character, index) => sum + (character === '<' ? 0 : /\d/.test(character) ? Number(character) : character.charCodeAt(0) - 55) * [7,3,1][index % 3], 0) % 10); }
function mrz({passportNumber='N12345678', birthDate='1990-01-15', expiryDate='2031-01-01', nationalityCode='EGY', issuingCountryCode='UTO', sex='F', latinFirstName='SYNTHETIC PERSON', latinFamilyName='EXAMPLE'} = {}) {
  const number = passportNumber.padEnd(9, '<'), birth = birthDate.replaceAll('-', '').slice(2), expiry = expiryDate.replaceAll('-', '').slice(2), optional = '<'.repeat(14);
  const first = ('P<' + issuingCountryCode + latinFamilyName.replaceAll(' ', '<') + '<<' + latinFirstName.replaceAll(' ', '<')).padEnd(44, '<');
  const second = number + digit(number) + nationalityCode + birth + digit(birth) + sex + expiry + digit(expiry) + optional + digit(optional);
  return [first, second + digit(second.slice(0,10) + second.slice(13,20) + second.slice(21,43))];
}
const field = (value, confidence=1) => ({value, confidence, visible:true});
function document(id, kind, fields, options={}) {
  return {mediaId:id,page:1,sha256:'a'.repeat(64),extraction:{version:1,kind,readable:true,rotation:0,fields:Object.fromEntries(Object.entries(fields).map(([key,value]) => [key, field(value)])),mrzLines:[],...options}};
}
function passport(values={}, id=IDS.passport) {
  const fields={latinFirstName:'SYNTHETIC PERSON',latinFamilyName:'EXAMPLE',passportNumber:'N12345678',passportType:'ordinary',nationalityCode:'EGY',issuingCountryCode:'UTO',birthDate:'1990-01-15',birthPlace:'Example City',sex:'F',issueDate:'2020-01-01',expiryDate:'2031-01-01',...values};
  return document(id,'passport',fields,{mrzLines:mrz(fields)});
}
function front(values={}, id=IDS.front) { return document(id,'uae_id_front',{latinFullName:'SYNTHETIC PERSON EXAMPLE',birthDate:'1990-01-15',nationalityCode:'EGY',sex:'F',emiratesId:'784-1900-1234567-3',residenceExpiry:'2027-04-30',...values}); }
function run(documents=[passport(),front()], applicants=[{nationality:'مصر'}], referenceDate=DAY) { return reconcileDocumentEvidence({documents,applicants,referenceDate}); }
function codes(result,index=0) { return result.applicants[index].issues.map(item => item.code); }

test('independently checked passport MRZ and matching visible identity produce a private ready dossier', () => {
  const result=run();
  assert.equal(DOCUMENT_CONFIDENCE_THRESHOLD,0.98); assert.equal(result.complete,true);
  const person=result.applicants[0]; assert.equal(person.status,'ready'); assert.equal(person.evidence.passportMrzChecked,true); assert.equal(person.evidence.matchedResidence,true);
  assert.equal(person.fields.nationalityCode,'EGY'); assert.equal(person.fields.issuingCountryCode,'UTO');
  assert.equal(person.fields.emiratesId,'784190012345673'); assert.equal(person.fields.latinGrandfatherName,undefined); assert.equal(person.fields.latinFullName,undefined);
  assert.deepEqual(person.documents.passport,{mediaId:IDS.passport,page:1,sha256:'a'.repeat(64)}); assert.equal(person.documents.residence.length,1); assert.equal(person.documents.photo,null);
  assert.equal(person.evidence.authenticityVerified,false); assert.equal(person.evidence.fieldSources.passportNumber[0].method,'td3_document_number_checked');
});

test('Emirates ID numeric year segment never supplies or contradicts the actual printed birth date', () => {
  const result=run([passport(),front({emiratesId:'784202212345673'})]);
  assert.equal(result.complete,true); assert.equal(result.applicants[0].fields.birthDate,'1990-01-15');
});

test('missing and uncertain optional father or grandfather names remain absent without extra required questions', () => {
  const p=passport(); p.extraction.fields.latinGrandfatherName={value:null,confidence:0,visible:false}; p.extraction.fields.arabicGrandfatherName=field('اسم غير مؤكد',0.4);
  const result=run([p,front()]); assert.equal(result.complete,true);
  for(const key of ['latinGrandfatherName','arabicGrandfatherName','latinFatherName']) assert.equal(Object.hasOwn(result.applicants[0].fields,key),false);
});

test('checked MRZ may link the full identity while unreadable optional name labels stay blank', () => {
  const p=passport({latinFirstName:'SYNTHETIC',latinFatherName:'PERSON'});
  p.extraction.fields.latinGrandfatherName=field('TRAILING',0.3);
  p.extraction.mrzLines=mrz({latinFirstName:'SYNTHETIC PERSON TRAILING'});
  const result=run([p,front({latinFullName:'SYNTHETIC PERSON TRAILING EXAMPLE'})]);
  assert.equal(result.complete,true); assert.equal(result.applicants[0].fields.latinFirstName,'SYNTHETIC'); assert.equal(result.applicants[0].fields.latinFatherName,'PERSON');
  assert.equal(Object.hasOwn(result.applicants[0].fields,'latinGrandfatherName'),false); assert.equal(Object.hasOwn(result.applicants[0].fields,'latinFullName'),false);
});

test('MRZ-only middle names never become father or grandfather fields', () => {
  const p=passport({latinFirstName:'SYNTHETIC'}); p.extraction.mrzLines=mrz({latinFirstName:'SYNTHETIC MIDDLE PERSON'});
  const result=run([p,front({latinFullName:'SYNTHETIC MIDDLE PERSON EXAMPLE'})]);
  assert.equal(result.complete,true); assert.equal(result.applicants[0].fields.latinFirstName,'SYNTHETIC'); assert.equal(Object.hasOwn(result.applicants[0].fields,'latinFatherName'),false); assert.equal(Object.hasOwn(result.applicants[0].fields,'latinGrandfatherName'),false);
  const mismatch=passport({latinFirstName:'SYNTHETIC'}); mismatch.extraction.mrzLines=mrz({latinFirstName:'SYNTHETICAL MIDDLE PERSON'});
  assert.equal(run([mismatch,front({latinFullName:'SYNTHETICAL MIDDLE PERSON EXAMPLE'})]).complete,false);
});

test('confidence below threshold cannot become trusted because a model supplied a complete-looking field', () => {
  const p=passport(); p.extraction.fields.birthDate.confidence=0.979;
  const result=run([p,front()]); assert.equal(result.complete,false); assert.equal(result.applicants[0].fields.birthDate,undefined);
  assert.ok(codes(result).includes('PASSPORT_MRZ_DATE_AMBIGUOUS')); assert.ok(codes(result).includes('DOCUMENT_FIELD_REQUIRED'));
});

test('the threshold boundary is accepted only with the existing independent checks', () => {
  const p=passport(),id=front(); for(const e of [...Object.values(p.extraction.fields),...Object.values(id.extraction.fields)]) e.confidence=0.98;
  assert.equal(run([p,id]).complete,true);
});

test('strong identity with only missing passport type, issue date and birthplace requests explicit client facts', () => {
  const p=passport(); for(const key of ['passportType','issueDate','birthPlace']) delete p.extraction.fields[key];
  const result=run([p,front()]),person=result.applicants[0];
  assert.equal(result.complete,false); assert.equal(person.identityReady,true); assert.equal(person.status,'needs_confirmation');
  assert.deepEqual(person.clientFieldsRequired,['passportType','issueDate','birthPlace']);
  for(const key of person.clientFieldsRequired) assert.equal(Object.hasOwn(person.fields,key),false);
  assert.ok(person.issues.every(item=>item.code==='DOCUMENT_FIELD_REQUIRED'));
});

test('unreadable allowed client gaps stay distinct from actual invalid values and identity conflicts', () => {
  const p=passport(); p.extraction.fields.issueDate.confidence=0.3;
  const person=run([p,front()]).applicants[0]; assert.equal(person.identityReady,true); assert.equal(person.status,'needs_confirmation'); assert.deepEqual(person.clientFieldsRequired,['issueDate']);
  for(const broken of [passport({issueDate:'2026-02-30'}),passport({birthPlace:'\u0000bad'})]){
    const result=run([broken,front()]).applicants[0]; assert.equal(result.identityReady,false); assert.equal(result.status,'needs_review'); assert.deepEqual(result.clientFieldsRequired,[]);
  }
  const conflict=run([p,front({birthDate:'1991-01-15'})]).applicants[0]; assert.equal(conflict.identityReady,false); assert.deepEqual(conflict.clientFieldsRequired,[]);
});

test('identity-critical gaps never become replaceable client facts', () => {
  for(const key of ['birthDate','expiryDate','latinFirstName']){
    const p=passport(); delete p.extraction.fields[key]; const person=run([p,front()]).applicants[0];
    assert.equal(person.identityReady,false,key); assert.equal(person.status,'needs_review',key); assert.deepEqual(person.clientFieldsRequired,[],key);
  }
});

test('valid-looking visual values do not repair failed MRZ check digits', () => {
  const p=passport(); p.extraction.mrzLines[1]=p.extraction.mrzLines[1].slice(0,9)+'0'+p.extraction.mrzLines[1].slice(10);
  const result=run([p,front()]); assert.equal(result.complete,false); assert.ok(codes(result).includes('PASSPORT_MRZ_INVALID')); assert.equal(result.applicants[0].evidence.passportMrzChecked,false);
});

test('valid MRZ for a different document cannot make contradictory visible passport data ready', () => {
  const p=passport(); p.extraction.mrzLines=mrz({passportNumber:'X12345678'});
  const result=run([p,front()]); assert.equal(result.complete,false); assert.ok(result.applicants[0].issues.some(item=>item.code==='PASSPORT_VIZ_MRZ_MISMATCH'&&item.field==='passportNumber'));
  assert.equal(result.applicants[0].fields.passportNumber,'X12345678'); assert.equal(result.applicants[0].evidence.passportNumberObservations[0].value,'N12345678');
});

test('visual full dates are mandatory for MRZ century resolution', () => {
  const p=passport(); delete p.extraction.fields.expiryDate;
  const result=run([p,front()]); assert.equal(result.complete,false); assert.equal(result.applicants[0].fields.expiryDate,undefined); assert.ok(codes(result).includes('PASSPORT_MRZ_DATE_AMBIGUOUS'));
});

test('invalid calendar dates and future issue dates cannot be approved', () => {
  for(const value of ['2026-02-30','2099-01-01']){
    const result=run([passport({issueDate:value}),front()]); assert.equal(result.complete,false); assert.ok(result.applicants[0].issues.some(item=>item.field==='issueDate'));
  }
});

test('visible and MRZ given/family names must agree without inventing missing name components', () => {
  const p=passport(); p.extraction.fields.latinFirstName=field('DIFFERENT PERSON');
  const result=run([p,front()]); assert.equal(result.complete,false); assert.ok(result.applicants[0].issues.some(item=>item.code==='PASSPORT_VIZ_MRZ_MISMATCH'&&item.field==='latinFirstName'));
});

test('printed identity birth date conflict is blocked and public issue labels do not repeat sensitive identifiers', () => {
  const result=run([passport(),front({birthDate:'1991-01-15'})]);
  assert.equal(result.complete,false); assert.ok(codes(result).includes('DOCUMENT_IDENTITY_MISMATCH')); assert.equal(result.unassigned.length,1);
  const text=JSON.stringify([...result.issues,...result.applicants[0].issues]); assert.equal(text.includes('784190012345673'),false); assert.equal(text.includes('N12345678'),false);
});

test('name normalization handles case, spacing and punctuation but never fuzzy spelling', () => {
  assert.equal(run([passport(),front({latinFullName:'  synthetic  person  example '})]).complete,true);
  const result=run([passport(),front({latinFullName:'SYNTHETIK PERSON EXAMPLE'})]); assert.equal(result.complete,false); assert.ok(codes(result).includes('DOCUMENT_IDENTITY_MISMATCH'));
});

test('front and back are linked by the same explicit ID and can arrive in either order', () => {
  const p=passport(),f=front(); delete f.extraction.fields.residenceExpiry;
  const back=document(IDS.back,'uae_id_back',{emiratesId:'784190012345673',residenceExpiry:'2027-04-30'});
  for(const docs of [[back,p,f],[p,f,back]]){
    const result=run(docs); assert.equal(result.complete,true); assert.equal(result.applicants[0].documents.residence.length,2); assert.equal(result.applicants[0].fields.residenceExpiry,'2027-04-30');
  }
});

test('a back page without an identity link is never assigned merely because there is one applicant', () => {
  const p=passport(),f=front(); delete f.extraction.fields.residenceExpiry;
  const back=document(IDS.back,'uae_id_back',{residenceExpiry:'2027-04-30'});
  const result=run([p,f,back]); assert.equal(result.complete,false); assert.equal(result.applicants[0].fields.residenceExpiry,undefined); assert.ok(result.unassigned.some(item=>item.mediaId===IDS.back));
});

test('conflicting residence IDs or expiry dates remain conflicts, never latest-value wins', () => {
  for(const patch of [{emiratesId:'784190012345674'},{residenceExpiry:'2028-01-01'}]){
    const extra=front(patch,IDS.back);extra.sha256='b'.repeat(64);
    const result=run([passport(),front(),extra]); assert.equal(result.complete,false); assert.ok(codes(result).includes('RESIDENCE_CONFLICT'));
  }
});

test('multiple applicants map independently by exact identities rather than arrival order', () => {
  const p=passport(),second={latinFirstName:'SECOND PERSON',latinFamilyName:'EXAMPLE',passportNumber:'N12345679',birthDate:'1985-03-12'};
  const p2=passport(second,IDS.passport2),id2=front({latinFullName:'SECOND PERSON EXAMPLE',birthDate:'1985-03-12',emiratesId:'784198512345673'},IDS.front2);
  p2.sha256='b'.repeat(64);id2.sha256='c'.repeat(64);
  const people=[{passportNumber:'N12345678'},{passportNumber:'N12345679'}];
  const first=run([id2,p2,front(),p],people),reverse=run([p,front(),p2,id2],people);
  assert.equal(first.complete,true); assert.equal(reverse.complete,true);
  assert.equal(first.applicants[0].fields.passportNumber,'N12345678'); assert.equal(first.applicants[1].fields.passportNumber,'N12345679');
  assert.equal(first.applicants[0].documents.residence[0].mediaId,IDS.front); assert.equal(first.applicants[1].documents.residence[0].mediaId,IDS.front2);
});

test('ambiguous applicants cannot claim the same passport even when its number is correct', () => {
  const result=run([passport(),front()],[{passportNumber:'N12345678'},{passportNumber:'N12345678'}]);
  assert.equal(result.complete,false); assert.ok(result.applicants.every(person=>person.documents.passport===null)); assert.equal(result.unassigned.length,2);
});

test('case identity conflicts are preserved for clarification and caller objects are unchanged', () => {
  const documents=[passport(),front()],applicants=[{passportNumber:'N12345678',birthDate:'1980-01-15',nationality:'سوريا'}];
  const before=structuredClone({documents,applicants}); const result=run(documents,applicants);
  assert.equal(result.complete,false); assert.ok(codes(result).includes('CASE_DATA_MISMATCH')); assert.deepEqual({documents,applicants},before);
});

test('duplicate identical sources are idempotent while changed hashes or contradictory extraction cannot win by ordering', () => {
  const p=passport(),f=front(); assert.equal(run([p,structuredClone(p),f]).complete,true);
  for(const changed of [{...structuredClone(p),sha256:'b'.repeat(64)},passport({birthPlace:'Changed City'})]){
    const result=run([p,changed,f]); assert.equal(result.complete,false); assert.ok(result.issues.some(item=>item.code==='SOURCE_CONFLICT')); assert.equal(result.applicants[0].documents.passport,null);
  }
});

test('the same identity on duplicate passport images can be recognized, but different passports need selection', () => {
  assert.equal(run([passport(),passport({},IDS.passport2),front()]).complete,true);
  const other=passport({passportNumber:'N12345679'},IDS.passport2);other.sha256='b'.repeat(64);
  const result=run([passport(),other,front()]); assert.equal(result.complete,false); assert.ok(codes(result).includes('MULTIPLE_PASSPORTS'));
});

test('calendar-month validity boundaries use the existing policy, not guessed day counts', () => {
  const valid=run([passport({expiryDate:'2027-05-12'}),front({residenceExpiry:'2027-01-28'})]); assert.equal(valid.complete,true);
  const passportShort=run([passport({expiryDate:'2027-05-11'}),front()]); assert.equal(passportShort.complete,false); assert.ok(codes(passportShort).includes('PASSPORT_VALIDITY'));
  const residenceShort=run([passport(),front({residenceExpiry:'2027-01-27'})]); assert.equal(residenceShort.complete,false); assert.ok(codes(residenceShort).includes('RESIDENCE_VALIDITY'));
});

test('an explicit entry date affects validity checks but no proposed travel date is emitted as a customer fact', () => {
  const result=run([passport({expiryDate:'2027-05-12'}),front()],[{entryDate:'2026-12-01'}]); assert.equal(result.complete,false); assert.ok(codes(result).includes('PASSPORT_VALIDITY'));
  assert.equal(Object.hasOwn(result.applicants[0].fields,'entryDate'),false);
});

test('invalid Emirates ID format blocks readiness; number format is never proof of authenticity', () => {
  const result=run([passport(),front({emiratesId:'123199012345673'})]); assert.equal(result.complete,false); assert.ok(result.applicants[0].issues.some(item=>item.field==='emiratesId'));
});

test('unknown fields and object keys cannot add legal answers or pollute the output prototype', () => {
  const p=passport(); p.extraction.fields={...p.extraction.fields,...JSON.parse('{"__proto__":{"value":"unsafe","confidence":1,"visible":true},"health":{"value":"false","confidence":1,"visible":true},"maritalStatus":{"value":"single","confidence":1,"visible":true}}')};
  const result=run([p,front()]); assert.equal(result.complete,true); assert.equal(Object.hasOwn(result.applicants[0].fields,'health'),false); assert.equal(Object.hasOwn(result.applicants[0].fields,'maritalStatus'),false); assert.equal({}.unsafe,undefined);
});

test('prototype-valued strings and inherited evidence cannot become fields', () => {
  const p=passport(); p.extraction.fields.sex=field('constructor');
  const result=run([p,front()]); assert.equal(result.complete,false); assert.equal(result.applicants[0].fields.sex,'constructor'); assert.ok(result.applicants[0].issues.some(item=>item.field==='sex'));
  const inherited=passport(); inherited.extraction.fields=Object.create(inherited.extraction.fields);
  assert.equal(run([inherited,front()]).complete,false);
});

test('malformed confidence, unreadability and unsupported MRZ shapes never become ready', () => {
  const broken=passport(); broken.extraction.fields.passportNumber.confidence=Infinity;
  assert.equal(run([broken,front()]).complete,false);
  const unreadable=passport(); unreadable.extraction.readable=false; const result=run([unreadable,front()]); assert.equal(result.complete,false); assert.ok(result.issues.some(item=>item.code==='DOCUMENT_UNREADABLE'));
  const noMrz=passport(); noMrz.extraction.mrzLines=[]; assert.ok(codes(run([noMrz,front()])).includes('PASSPORT_MRZ_REQUIRED'));
});

test('a standalone portrait is associated only in an unambiguous single-applicant case', () => {
  const photo=document(IDS.portrait,'portrait',{}); const result=run([passport(),front(),photo]); assert.equal(result.complete,true); assert.equal(result.applicants[0].documents.photo.mediaId,IDS.portrait);
  const multi=run([photo],[{},{}]); assert.equal(multi.applicants[0].documents.photo,null); assert.equal(multi.applicants[1].documents.photo,null); assert.equal(multi.unassigned.length,1);
});

test('no applicant is invented from an attachment and invalid root inputs fail with a bounded code', () => {
  const result=run([passport(),front()],[]); assert.equal(result.complete,false); assert.equal(result.applicants.length,0); assert.ok(result.issues.some(item=>item.code==='APPLICANT_REQUIRED'));
  for(const input of [{documents:null,applicants:[]},{documents:[],applicants:[null]},{documents:[],applicants:[],referenceDate:'2026-02-30'}]) assert.throws(()=>reconcileDocumentEvidence(input),error=>error.code==='DOCUMENT_MATCH_INPUT_INVALID');
});

test('two strongly linked passport pages merge visible facts with one checked MRZ and preserve both page sources', () => {
  const p=passport(); for (const key of ['issueDate','birthPlace','passportType']) delete p.extraction.fields[key];
  const supplement=document(IDS.passport2,'passport',{passportNumber:'N12345678',issueDate:'2020-01-01',birthPlace:'Example City',passportType:'ordinary'}); supplement.sha256='b'.repeat(64);
  const before=structuredClone([p,supplement,front()]);
  const result=run(before),reverse=run([supplement,front(),p]);
  assert.equal(result.complete,true); assert.deepEqual(reverse,result);
  const person=result.applicants[0];
  assert.deepEqual(person.documents.passportParts,[{mediaId:IDS.passport,page:1,sha256:'a'.repeat(64)},{mediaId:IDS.passport2,page:1,sha256:'b'.repeat(64)}]);
  assert.deepEqual(person.documents.passport,person.documents.passportParts[0]);
  assert.equal(person.fields.issueDate,'2020-01-01'); assert.equal(person.evidence.fieldSources.issueDate[0].mediaId,IDS.passport2);
  assert.equal(person.evidence.passportMrzChecked,true); assert.deepEqual(before,[p,supplement,front()]);
});

test('printed full-name and birth-date can anchor a supplementary page without a passport number', () => {
  const p=passport(); delete p.extraction.fields.birthPlace;
  const supplement=document(IDS.passport2,'passport',{latinFullName:'SYNTHETIC PERSON EXAMPLE',birthDate:'1990-01-15',birthPlace:'Example City'}); supplement.sha256='b'.repeat(64);
  const result=run([supplement,p,front()]); assert.equal(result.complete,true); assert.equal(result.applicants[0].documents.passportParts.length,2);
  assert.equal(Object.hasOwn(result.applicants[0].fields,'latinFullName'),false);
});

test('a separately printed full visual date may resolve a checked MRZ century only after strong page linkage', () => {
  const p=passport(); delete p.extraction.fields.birthDate; delete p.extraction.fields.expiryDate;
  const supplement=document(IDS.passport2,'passport',{passportNumber:'N12345678',birthDate:'1990-01-15',expiryDate:'2031-01-01'}); supplement.sha256='b'.repeat(64);
  const person=run([p,supplement,front()]).applicants[0];
  assert.equal(person.status,'ready'); assert.equal(person.evidence.passportMrzChecked,true);
  assert.equal(person.evidence.fieldSources.birthDate[0].mediaId,IDS.passport2);
  const unanchored=structuredClone(supplement); delete unanchored.extraction.fields.passportNumber;
  const result=run([p,unanchored,front()]); assert.equal(result.complete,false); assert.ok(result.unassigned.some(ref=>ref.mediaId===IDS.passport2));
});

test('a name without the matching birth date cannot attach a page or fill absent passport data', () => {
  const p=passport(); delete p.extraction.fields.birthPlace;
  const supplement=document(IDS.passport2,'passport',{latinFullName:'SYNTHETIC PERSON EXAMPLE',birthPlace:'Example City'}); supplement.sha256='b'.repeat(64);
  const result=run([p,supplement,front()],[{passportNumber:'N12345678'}]);
  assert.equal(result.complete,false); assert.equal(result.applicants[0].fields.birthPlace,undefined); assert.equal(result.applicants[0].documents.passportParts,undefined);
  assert.ok(result.unassigned.some(ref=>ref.mediaId===IDS.passport2));
});

test('supplementary contradictions and a supplied invalid MRZ block a passport even when another page is valid', () => {
  for (const fields of [{birthDate:'1991-01-15'},{expiryDate:'2032-01-01'},{issueDate:'2021-01-01'},{latinFullName:'DIFFERENT PERSON EXAMPLE'}]) {
    const supplement=document(IDS.passport2,'passport',{passportNumber:'N12345678',...fields}); supplement.sha256='b'.repeat(64);
    const result=run([passport(),supplement,front()]); assert.equal(result.complete,false); assert.ok(codes(result).some(code=>['MULTIPLE_PASSPORTS','PASSPORT_VIZ_MRZ_MISMATCH'].includes(code)));
  }
  const supplement=passport({},IDS.passport2); supplement.sha256='b'.repeat(64);
  supplement.extraction.mrzLines[1]=supplement.extraction.mrzLines[1].slice(0,9)+'0'+supplement.extraction.mrzLines[1].slice(10);
  const result=run([passport(),supplement,front()]); assert.equal(result.complete,false); assert.ok(codes(result).includes('PASSPORT_MRZ_INVALID'));
});

test('invalid critical metadata on a linked supplement is not erased by valid primary values', () => {
  const supplement=document(IDS.passport2,'passport',{passportNumber:'N12345678',birthPlace:'Example City'}); supplement.sha256='b'.repeat(64);
  supplement.extraction.fields.issueDate={value:'2020-01-01',confidence:Infinity,visible:true};
  const result=run([passport(),supplement,front()]); assert.equal(result.complete,false); assert.ok(result.applicants[0].issues.some(item=>item.code==='DOCUMENT_FIELD_INVALID'&&item.field==='issueDate'));
});

test('more than two distinct linked passport pages require selection and never become an accepted two-page bundle', () => {
  const second=document(IDS.passport2,'passport',{passportNumber:'N12345678',issueDate:'2020-01-01'}); second.sha256='b'.repeat(64);
  const third=document(IDS.portrait,'passport',{passportNumber:'N12345678',birthPlace:'Example City'}); third.sha256='c'.repeat(64);
  const result=run([passport(),second,third,front()]); assert.equal(result.complete,false); assert.equal(result.applicants[0].documents.passportParts,undefined);
  assert.ok(codes(result).includes('MULTIPLE_PASSPORTS')); assert.equal(result.unassigned.length,2);
});

test('byte-identical reuploads deduplicate passport and identity pages while distinct page images remain linked', () => {
  const p=passport(),p2=passport({},IDS.passport2),f=front(),f2=front({},IDS.front2);
  const result=run([p2,f2,p,f]); assert.equal(result.complete,true); assert.equal(result.applicants[0].documents.passportParts,undefined);
  assert.equal(result.applicants[0].documents.residence.length,1); assert.equal(result.applicants[0].documents.residence[0].mediaId,IDS.front);
  assert.equal(result.applicants[0].evidence.fieldSources.passportNumber.length,1);
  p2.sha256='b'.repeat(64); const distinct=run([p,p2,f]); assert.equal(distinct.complete,true); assert.equal(distinct.applicants[0].documents.passportParts,undefined);assert.equal(distinct.applicants[0].evidence.passportLogicalDuplicates.length,1);
});

test('reuploaded PDF digests deduplicate only matching pages, never every page in the original PDF', () => {
  const p=passport(); p.sourceSha256='d'.repeat(64);
  const copy=passport({},IDS.passport2); copy.sourceSha256=p.sourceSha256; copy.sha256='b'.repeat(64);
  const duplicate=run([p,copy,front()]); assert.equal(duplicate.complete,true); assert.equal(duplicate.applicants[0].documents.passportParts,undefined);
  const supplementary=document(IDS.passport,'passport',{passportNumber:'N12345678',issueDate:'2020-01-01'}); supplementary.page=2; supplementary.sha256='c'.repeat(64); supplementary.sourceSha256=p.sourceSha256;
  const result=run([p,copy,supplementary,front()]); assert.equal(result.complete,true); assert.deepEqual(result.applicants[0].documents.passportParts.map(ref=>ref.page),[1,2]);
});

test('identity sides are always ordered front then back despite input order or ID lexical order', () => {
  const f=front({},IDS.back); delete f.extraction.fields.residenceExpiry;
  const back=document(IDS.front,'uae_id_back',{emiratesId:'784190012345673',residenceExpiry:'2027-04-30'}); back.sha256='b'.repeat(64);
  const result=run([back,passport(),f]); assert.equal(result.complete,true); assert.deepEqual(result.applicants[0].documents.residence.map(ref=>ref.mediaId),[IDS.back,IDS.front]);
  const copy=structuredClone(back); copy.mediaId=IDS.front2;
  assert.equal(run([copy,back,passport(),f]).applicants[0].documents.residence.length,2);
});

test('different people cannot merge through arrival order and exact full name alone is insufficient', () => {
  const p=passport(),supplement=document(IDS.passport2,'passport',{latinFullName:'SYNTHETIC PERSON EXAMPLE',birthDate:'1991-01-15',issueDate:'2020-01-01'}); supplement.sha256='b'.repeat(64);
  const result=run([supplement,p,front()],[{passportNumber:'N12345678'}]); assert.equal(result.complete,false); assert.equal(result.applicants[0].documents.passportParts,undefined);
  assert.ok(result.unassigned.some(ref=>ref.mediaId===IDS.passport2));
});

test('an unanchored dates-only page leaves a unique main passport and matched ID visible without importing its dates',()=>{
 const p=passport();p.extraction.mrzLines=[];for(const field of ['issueDate','expiryDate','birthPlace'])delete p.extraction.fields[field];
 const supplement=document(IDS.passport2,'passport',{issueDate:'2020-01-01',expiryDate:'2031-01-01',birthPlace:'Example City'});supplement.sha256='b'.repeat(64);
 const id=front(),photo=document(IDS.portrait,'portrait',{}),result=run([supplement,id,photo,p]),person=result.applicants[0];
 assert.equal(result.complete,false);assert.equal(person.status,'needs_review');assert.equal(person.identityReady,false);assert.equal(person.evidence.passportMrzChecked,false);
 assert.equal(person.fields.passportNumber,'N12345678');assert.equal(person.fields.latinFirstName,'SYNTHETIC PERSON');assert.equal(person.fields.birthDate,'1990-01-15');
 for(const key of ['issueDate','expiryDate','birthPlace'])assert.equal(Object.hasOwn(person.fields,key),false,key);
 assert.equal(person.fields.emiratesId,'784190012345673');assert.equal(person.documents.passport.mediaId,IDS.passport);assert.deepEqual(person.documents.residence.map(ref=>ref.mediaId),[IDS.front]);assert.equal(person.documents.photo.mediaId,IDS.portrait);
 assert.deepEqual(result.unassigned.map(ref=>ref.mediaId),[IDS.passport2]);assert.ok(result.issues.some(issue=>issue.code==='DOCUMENT_UNASSIGNED'));
 assert.ok(person.issues.some(issue=>issue.code==='PASSPORT_MRZ_REQUIRED'));assert.equal(person.documents.passportParts,undefined);
 assert.deepEqual(run([p,photo,id,supplement]),result);
});

test('a complete checked passport remains separately usable while an unidentified page still requires review',()=>{
 const supplement=document(IDS.passport2,'passport',{issueDate:'2021-01-01'});supplement.sha256='b'.repeat(64);
 const result=run([supplement,passport(),front()]),person=result.applicants[0];
 assert.equal(result.complete,false);assert.equal(person.identityReady,true);assert.equal(person.fields.issueDate,'2020-01-01');assert.equal(person.documents.passportParts,undefined);
 assert.ok(result.unassigned.some(ref=>ref.mediaId===IDS.passport2));
});

test('a sole-applicant fallback never chooses between different identifiable passports or people',()=>{
 for(const fields of [
  {passportNumber:'X12345678'},
  {latinFullName:'SECOND PERSON EXAMPLE',birthDate:'1985-03-12'},
 ]){
  const extra=document(IDS.passport2,'passport',fields);extra.sha256='b'.repeat(64);
  const result=run([extra,passport(),front()]);assert.equal(result.complete,false);assert.equal(result.applicants[0].documents.passport,null);assert.equal(result.applicants[0].identityReady,false);
 }
 // A name without a passport number and real birth date is insufficient for
 // selecting the main page among other unassigned pages.
 const weak=passport();delete weak.extraction.fields.birthDate;weak.extraction.mrzLines=[];
 const dates=document(IDS.passport2,'passport',{issueDate:'2020-01-01'});dates.sha256='b'.repeat(64);
 const result=run([weak,dates,front()]);assert.equal(result.applicants[0].documents.passport,null);assert.equal(result.complete,false);
});

test('same-pixel reuploads with abstentions and confidence differences are one page with exact field provenance',()=>{
 const p=passport(),copy=passport({},IDS.passport2);delete p.extraction.fields.birthPlace;delete copy.extraction.fields.issueDate;
 for(const evidence of Object.values(copy.extraction.fields))evidence.confidence=0.99;
 const id=front(),idCopy=front({},IDS.front2);delete id.extraction.fields.residenceExpiry;idCopy.extraction.fields.residenceExpiry.confidence=0.99;
 const result=run([copy,idCopy,p,id]),person=result.applicants[0];assert.equal(result.complete,true);assert.equal(person.documents.passportParts,undefined);assert.equal(person.documents.residence.length,1);
 assert.equal(person.fields.birthPlace,'Example City');assert.equal(person.fields.issueDate,'2020-01-01');assert.equal(person.evidence.fieldSources.birthPlace.length,1);assert.equal(person.evidence.fieldSources.birthPlace[0].mediaId,IDS.passport2);
 assert.equal(person.evidence.fieldSources.issueDate[0].mediaId,IDS.passport);assert.equal(person.evidence.fieldSources.residenceExpiry[0].mediaId,IDS.front2);
 assert.deepEqual(run([id,p,idCopy,copy]),result);
});

test('ten original uploads with duplicate OCR variations retain the main facts and do not invent a page anchor',()=>{
 const p=passport();p.extraction.mrzLines=[];delete p.extraction.fields.issueDate;delete p.extraction.fields.expiryDate;
 const dates=document(IDS.passport2,'passport',{issueDate:'2020-01-01',expiryDate:'2031-01-01'});dates.sha256='b'.repeat(64);
 const id=front();delete id.extraction.fields.residenceExpiry;
 const back=document(IDS.back,'uae_id_back',{emiratesId:'784190012345673',residenceExpiry:'2027-04-30'});back.sha256='c'.repeat(64);
 const photo=document(IDS.portrait,'portrait',{});photo.sha256='d'.repeat(64);
 const originals=[p,dates,id,back,photo],copies=originals.map((document,index)=>{const copy=structuredClone(document);copy.mediaId='22345678-1234-4321-abcd-12345678900'+index;for(const evidence of Object.values(copy.extraction.fields))evidence.confidence=0.99;return copy;});
 delete copies[0].extraction.fields.birthPlace;
 const result=run([...copies,...originals]),person=result.applicants[0];assert.equal(person.fields.passportNumber,'N12345678');assert.equal(person.fields.latinFamilyName,'EXAMPLE');assert.equal(person.fields.emiratesId,'784190012345673');assert.equal(person.fields.residenceExpiry,'2027-04-30');
 assert.equal(person.documents.residence.length,2);assert.equal(person.documents.photo.mediaId,IDS.portrait);assert.equal(person.documents.passportParts,undefined);assert.equal(person.fields.expiryDate,undefined);assert.equal(person.fields.issueDate,undefined);assert.equal(person.identityReady,false);assert.equal(result.unassigned.length,1);
});

test('a raw-file/page digest also deduplicates consistent OCR variations without collapsing other PDF pages',()=>{
 const p=passport(),copy=passport({},IDS.passport2);p.sourceSha256='e'.repeat(64);copy.sourceSha256=p.sourceSha256;copy.sha256='b'.repeat(64);delete copy.extraction.fields.birthPlace;
 const supplement=document(IDS.passport,'passport',{passportNumber:'N12345678',issueDate:'2020-01-01'});supplement.sourceSha256=p.sourceSha256;supplement.page=2;supplement.sha256='c'.repeat(64);
 const result=run([copy,supplement,front(),p]);assert.equal(result.complete,true);assert.deepEqual(result.applicants[0].documents.passportParts.map(ref=>ref.page),[1,2]);
});

test('same physical image with contradictory trusted OCR or MRZ remains a blocking conflict',()=>{
 for(const kind of ['passport','residence'])for(const patch of kind==='passport'?[{passportNumber:'X12345678'},{expiryDate:'2032-01-01'}]:[{emiratesId:'784190012345674'},{residenceExpiry:'2028-01-01'}]){
  const first=kind==='passport'?passport():front(),copy=kind==='passport'?passport(patch,IDS.passport2):front(patch,IDS.front2);
  const result=run(kind==='passport'?[first,copy,front()]:[passport(),first,copy]);assert.equal(result.complete,false);assert.equal(result.applicants[0].identityReady,false);assert.ok(codes(result).includes('SOURCE_CONFLICT'));
 }
 const p=passport(),copy=passport({},IDS.passport2);copy.extraction.mrzLines=mrz({passportNumber:'X12345678'});const mrzConflict=run([p,copy,front()]);assert.equal(mrzConflict.complete,false);assert.ok(codes(mrzConflict).includes('SOURCE_CONFLICT'));
 const rotated=passport({},IDS.passport2);rotated.extraction.rotation=90;assert.ok(codes(run([p,rotated,front()])).includes('SOURCE_CONFLICT'));
});

test('separately labelled father can be absent from MRZ given names while exact printed identity and DOB match the UAE ID',()=>{
 for(const withFullName of [false,true]){
  const p=passport({latinFirstName:'SYNTHETIC',latinFatherName:'PARENT',...(withFullName?{latinFullName:'SYNTHETIC PARENT EXAMPLE'}:{})});
  const result=run([p,front({latinFullName:'SYNTHETIC PARENT EXAMPLE'})]),person=result.applicants[0];
  assert.equal(result.complete,true);assert.equal(person.evidence.passportMrzChecked,true);assert.equal(person.evidence.matchedResidence,true);
  assert.equal(person.fields.latinFirstName,'SYNTHETIC');assert.equal(person.fields.latinFatherName,'PARENT');assert.equal(person.fields.latinGrandfatherName,undefined);assert.equal(person.fields.latinFullName,undefined);
 }
});

test('new printed-patronymic name evidence requires exact DOB and never ignores unrelated names or nationality conflicts',()=>{
 const p=passport({latinFirstName:'SYNTHETIC',latinFatherName:'PARENT'});
 for(const patch of [{latinFullName:'SYNTHETIC OTHER EXAMPLE'},{latinFullName:'SYNTHETIK PARENT EXAMPLE'},{birthDate:'1991-01-15'},{nationalityCode:'SYR'}]){
  const result=run([p,front({latinFullName:'SYNTHETIC PARENT EXAMPLE',...patch})]);assert.equal(result.complete,false);assert.equal(result.applicants[0].identityReady,false);
 }
 const id=front({latinFullName:'SYNTHETIC PARENT EXAMPLE',passportNumber:'N12345678'});delete id.extraction.fields.birthDate;
 assert.equal(run([p,id]).applicants[0].identityReady,false,'passport number alone does not authorize a newly added patronymic name variant without the exact DOB');
});

test('unprinted or uncertain father names are never inferred to make an ID name match',()=>{
 for(const uncertain of [false,true]){
  const p=passport({latinFirstName:'SYNTHETIC'});if(uncertain)p.extraction.fields.latinFatherName=field('PARENT',0.97);
  const result=run([p,front({latinFullName:'SYNTHETIC PARENT EXAMPLE'})]);assert.equal(result.complete,false);assert.equal(result.applicants[0].fields.latinFatherName,undefined);
 }
 const p=passport({latinFirstName:'SYNTHETIC',latinFatherName:'PARENT',latinFullName:'SYNTHETIC OTHER EXAMPLE'});
 const result=run([p,front({latinFullName:'SYNTHETIC PARENT EXAMPLE'})]);assert.equal(result.complete,false);assert.ok(result.applicants[0].issues.some(issue=>issue.code==='PASSPORT_VIZ_MRZ_MISMATCH'&&issue.field==='latinFullName'));
});

test('printed patronymic name agreement cannot repair invalid Emirates ID digits or an appended passport check digit',()=>{
 const p=passport({latinFirstName:'SYNTHETIC',latinFatherName:'PARENT'}),id=front({latinFullName:'SYNTHETIC PARENT EXAMPLE',emiratesId:'78419901234567'});
 const person=run([p,id]).applicants[0];assert.equal(person.evidence.passportMrzChecked,true);assert.equal(person.evidence.matchedResidence,true);assert.equal(person.identityReady,false);
 assert.ok(person.issues.some(issue=>issue.code==='DOCUMENT_FIELD_INVALID'&&issue.field==='emiratesId'));
 const wrong=structuredClone(p);wrong.extraction.fields.passportNumber=field(p.extraction.fields.passportNumber.value+p.extraction.mrzLines[1][9]);
 const result=run([wrong,front({latinFullName:'SYNTHETIC PARENT EXAMPLE'})]);assert.equal(result.complete,false);assert.equal(result.applicants[0].fields.passportNumber,p.extraction.fields.passportNumber.value);assert.equal(result.applicants[0].evidence.passportNumberObservations[0].value,wrong.extraction.fields.passportNumber.value);assert.ok(result.applicants[0].issues.some(issue=>issue.code==='PASSPORT_VIZ_MRZ_MISMATCH'&&issue.field==='passportNumber'));
});

function withCheckedNationalOptional(document,raw='00123456789<<<'){
 const copy=structuredClone(document),line=copy.extraction.mrzLines[1];assert.equal(raw.length,14);
 const second=line.slice(0,28)+raw+digit(raw);copy.extraction.mrzLines[1]=second+digit(second.slice(0,10)+second.slice(13,20)+second.slice(21,43));return copy;
}
function nationalDateCase(){
 const p=withCheckedNationalOptional(passport({latinFirstName:'SYNTHETIC',latinFatherName:'PARENT',expiryDate:'2031-09-11'}));delete p.extraction.fields.expiryDate;
 const datePage=document(IDS.passport2,'passport',{passportNationalNumber:'001-23456789',printedPassportExpiry:'11/09/2031'});datePage.sha256='b'.repeat(64);
 return{p,datePage,id:front({latinFullName:'SYNTHETIC PARENT EXAMPLE'})};
}

test('exact printed national number anchors a date-only passport page and full-year printed expiry resolves checked YYMMDD',()=>{
 const {p,datePage,id}=nationalDateCase(),result=run([datePage,id,p]),person=result.applicants[0];assert.equal(result.complete,true);assert.equal(person.fields.expiryDate,'2031-09-11');assert.equal(person.evidence.passportMrzChecked,true);
 assert.deepEqual(person.documents.passportParts.map(ref=>ref.mediaId),[IDS.passport,IDS.passport2]);
 const evidence=person.evidence.fieldSources.expiryDate[0];assert.equal(evidence.mediaId,IDS.passport2);assert.equal(evidence.evidenceField,'printedPassportExpiry');assert.equal(evidence.corroboratedBy.mediaId,IDS.passport);
 assert.equal(person.fields.passportNationalNumber,undefined);assert.equal(person.fields.printedPassportExpiry,undefined);assert.equal(JSON.stringify(result).includes('00123456789'),false);
 assert.deepEqual(run([p,id,datePage]),result);
});

test('national optional-data anchoring needs the entire explicitly printed number and preserves leading zeros',()=>{
 for(const value of [undefined,'001-23456780','0123456789','123456789','001/23456789','001234567890','23456789']){
  const {p,datePage,id}=nationalDateCase();if(value===undefined)delete datePage.extraction.fields.passportNationalNumber;else datePage.extraction.fields.passportNationalNumber=field(value);
  const result=run([p,datePage,id]);assert.equal(result.complete,false);assert.equal(result.applicants[0].fields.expiryDate,undefined);assert.equal(result.applicants[0].documents.passportParts,undefined);assert.ok(result.unassigned.some(ref=>ref.mediaId===IDS.passport2));
 }
 const f=nationalDateCase();f.datePage.extraction.fields.passportNationalNumber.confidence=0.899;assert.equal(run([f.p,f.datePage,f.id]).applicants[0].fields.expiryDate,undefined);
});

test('all five TD3 checks and complete layout are mandatory before optional data can anchor another page',()=>{
 for(const offset of [9,19,27,42,43]){
  const {p,datePage,id}=nationalDateCase(),line=p.extraction.mrzLines[1];p.extraction.mrzLines[1]=line.slice(0,offset)+(Number(line[offset])+1)%10+line.slice(offset+1);
  const result=run([p,datePage,id]);assert.equal(result.complete,false);assert.equal(result.applicants[0].fields.expiryDate,undefined);assert.equal(result.applicants[0].documents.passportParts,undefined);
 }
 const {p,datePage,id}=nationalDateCase();p.extraction.mrzLines[1]=p.extraction.mrzLines[1].slice(0,43);const result=run([p,datePage,id]);assert.equal(result.complete,false);assert.equal(result.applicants[0].fields.expiryDate,undefined);
});

test('checked optional data alone does not create a national field or infer the expiry century',()=>{
 const {p,id}=nationalDateCase();const result=run([p,id]);assert.equal(result.complete,false);assert.equal(result.applicants[0].fields.expiryDate,undefined);assert.equal(result.applicants[0].fields.passportNationalNumber,undefined);
 const f=nationalDateCase();f.datePage.extraction.fields.printedPassportExpiry=field('11/09/31');const invalid=run([f.p,f.datePage,f.id]);assert.equal(invalid.complete,false);assert.equal(invalid.applicants[0].fields.expiryDate,undefined);
 const explicit=nationalDateCase();explicit.datePage.extraction.fields.printedPassportExpiry=field('11/09/1931');const past=run([explicit.p,explicit.datePage,explicit.id]);assert.equal(past.complete,false);assert.equal(past.applicants[0].fields.expiryDate,'1931-09-11');assert.ok(codes(past).includes('PASSPORT_VALIDITY'));
});

test('unmatched printed expiry and conflicting government expiry remain blockers rather than being overwritten',()=>{
 const f=nationalDateCase();f.datePage.extraction.fields.printedPassportExpiry=field('12/09/2031');const mismatch=run([f.p,f.datePage,f.id]);assert.equal(mismatch.complete,false);assert.equal(mismatch.applicants[0].fields.expiryDate,undefined);assert.ok(mismatch.applicants[0].issues.some(issue=>issue.code==='PASSPORT_VIZ_MRZ_MISMATCH'&&issue.field==='expiryDate'));
 const p=withCheckedNationalOptional(passport({expiryDate:'2031-09-11',printedPassportExpiry:'12/09/2031'}));const direct=run([p,front()]);assert.equal(direct.complete,false);assert.equal(direct.applicants[0].fields.expiryDate,'2031-09-11');assert.ok(direct.applicants[0].issues.some(issue=>issue.code==='PASSPORT_VIZ_MRZ_MISMATCH'&&issue.field==='expiryDate'));
});

test('a printed expiry on the same checked passport page needs no separate-page number anchor',()=>{
 const p=passport({expiryDate:'2031-09-11',printedPassportExpiry:'11/09/2031'});delete p.extraction.fields.expiryDate;
 const result=run([p,front()]);assert.equal(result.complete,true);assert.equal(result.applicants[0].fields.expiryDate,'2031-09-11');assert.equal(result.applicants[0].evidence.fieldSources.expiryDate[0].mediaId,IDS.passport);
});

test('source conflicts on explicit national-number evidence cannot be discarded to make an anchored dossier ready',()=>{
 const {p,datePage,id}=nationalDateCase(),copy=structuredClone(datePage);copy.mediaId=IDS.portrait;copy.extraction.fields.passportNationalNumber=field('001-23456780');
 const result=run([p,datePage,copy,id]);assert.equal(result.complete,false);assert.equal(result.applicants[0].identityReady,false);assert.ok([...codes(result),...result.issues.map(issue=>issue.code)].includes('SOURCE_CONFLICT'));
});

test('typed VIZ number and checked TD3 number have separate provenance without fabricated OCR confidence',()=>{
 const p=passport(),number=p.extraction.fields.passportNumber.value;delete p.extraction.fields.passportNumber;p.extraction.fields.visiblePassportNumber=field(number,0.99);
 const result=run([p,front()]),person=result.applicants[0];assert.equal(result.complete,true);assert.equal(person.fields.passportNumber,number);assert.equal(person.fields.visiblePassportNumber,undefined);
 const source=person.evidence.fieldSources.passportNumber[0];assert.equal(source.method,'td3_document_number_checked');assert.equal(source.evidenceField,'mrzLines');assert.equal(Object.hasOwn(source,'confidence'),false);assert.deepEqual(source.checks,['documentNumber','birthDate','expiryDate','optionalData','composite']);
 assert.equal(person.evidence.passportNumberObservations[0].evidenceField,'visiblePassportNumber');assert.equal(person.evidence.passportNumberObservations[0].value,number);assert.equal(person.evidence.passportNumberObservations[0].confidence,0.99);
});

test('checked TD3 positions supply the number when no VIZ number is independently readable, without creating other missing facts',()=>{
 const p=passport();delete p.extraction.fields.passportNumber;
 const result=run([p,front()]);assert.equal(result.complete,true);assert.equal(result.applicants[0].fields.passportNumber,'N12345678');assert.deepEqual(result.applicants[0].evidence.passportNumberObservations,[]);assert.equal(Object.hasOwn(result.applicants[0].evidence.fieldSources.passportNumber[0],'confidence'),false);
 for(const missing of ['birthDate','expiryDate','latinFirstName']){
  const copy=structuredClone(p);delete copy.extraction.fields[missing];const person=run([copy,front()]).applicants[0];assert.equal(person.identityReady,false,missing);assert.equal(person.fields[missing],undefined,missing);
 }
});

test('neither typed ten-digit VIZ nor cached ten-digit legacy values are truncated or erased by a checked nine-position MRZ',()=>{
 for(const evidenceField of ['passportNumber','visiblePassportNumber']){
  const p=passport(),value=p.extraction.fields.passportNumber.value+p.extraction.mrzLines[1][9];delete p.extraction.fields.passportNumber;p.extraction.fields[evidenceField]=field(value);
  const before=structuredClone(p),result=run([p,front()]),person=result.applicants[0];assert.equal(result.complete,false);assert.equal(person.identityReady,false);assert.equal(person.fields.passportNumber,'N12345678');assert.ok(person.issues.some(issue=>issue.code==='PASSPORT_VIZ_MRZ_MISMATCH'&&issue.field==='passportNumber'));
  assert.equal(person.evidence.passportNumberObservations[0].value,value);assert.equal(person.evidence.passportNumberObservations[0].evidenceField,evidenceField);assert.deepEqual(p,before);
 }
});

test('new typed evidence never suppresses an existing contradictory legacy observation',()=>{
 const p=passport(),legacy=p.extraction.fields.passportNumber.value+p.extraction.mrzLines[1][9];p.extraction.fields.visiblePassportNumber=field('N12345678');p.extraction.fields.passportNumber=field(legacy);
 const person=run([p,front()]).applicants[0];assert.equal(person.identityReady,false);assert.equal(person.fields.passportNumber,'N12345678');assert.deepEqual(person.evidence.passportNumberObservations.map(item=>item.value),[legacy,'N12345678']);assert.ok(person.issues.some(issue=>issue.code==='PASSPORT_VIZ_MRZ_MISMATCH'&&issue.field==='passportNumber'));
});

test('every check digit must pass before an MRZ-only number is projected, while unverified typed VIZ stays provisional',()=>{
 for(const offset of [9,19,27,42,43]){
  const p=passport();delete p.extraction.fields.passportNumber;const line=p.extraction.mrzLines[1];p.extraction.mrzLines[1]=line.slice(0,offset)+(Number(line[offset])+1)%10+line.slice(offset+1);
  const result=run([p,front()]);assert.equal(result.complete,false);assert.equal(result.applicants[0].fields.passportNumber,undefined);
 }
 const p=passport();p.extraction.fields.visiblePassportNumber=p.extraction.fields.passportNumber;delete p.extraction.fields.passportNumber;p.extraction.mrzLines=[];
 const person=run([p,front()]).applicants[0];assert.equal(person.identityReady,false);assert.equal(person.fields.passportNumber,'N12345678');const source=person.evidence.fieldSources.passportNumber[0];assert.equal(source.method,'visible_unconfirmed');assert.equal(source.evidenceField,'visiblePassportNumber');assert.equal(source.confidence,1);
});

test('number projection can remain provisional while full date centuries are unresolved and never proves nationality',()=>{
 const p=passport();delete p.extraction.fields.passportNumber;delete p.extraction.fields.expiryDate;
 const person=run([p,front()]).applicants[0];assert.equal(person.fields.passportNumber,'N12345678');assert.equal(person.evidence.fieldSources.passportNumber[0].method,'td3_document_number_checked');assert.equal(person.identityReady,false);assert.ok(person.issues.some(issue=>issue.code==='PASSPORT_MRZ_DATE_AMBIGUOUS'));
 const wrong=passport({nationalityCode:'SYR'});wrong.extraction.mrzLines=mrz({nationalityCode:'EGY'});const mismatch=run([wrong,front()]).applicants[0];assert.equal(mismatch.identityReady,false);assert.equal(mismatch.fields.nationalityCode,'SYR');assert.ok(mismatch.issues.some(issue=>issue.code==='PASSPORT_VIZ_MRZ_MISMATCH'&&issue.field==='nationalityCode'));
});

test('exact-pixel duplicate reads retain every literal number conflict after canonical projection and group reinspection',()=>{
 const p=passport(),copy=passport({},IDS.passport2);copy.extraction.fields.visiblePassportNumber=field('N123456785');delete copy.extraction.fields.passportNumber;
 const result=run([p,copy,front()]),person=result.applicants[0];assert.equal(result.complete,false);assert.equal(person.identityReady,false);assert.ok(person.issues.some(issue=>['SOURCE_CONFLICT','PASSPORT_VIZ_MRZ_MISMATCH'].includes(issue.code)&&issue.field==='passportNumber'));
 assert.deepEqual(new Set(person.evidence.passportNumberObservations.map(item=>item.value)),new Set(['N12345678','N123456785']));assert.equal(Object.hasOwn(person.evidence.fieldSources.passportNumber[0],'confidence'),false);
});

test('absent country zones are literal MRZ transcriptions with separate nationality corroboration and no invented confidence or check proof',()=>{
 const p=passport();delete p.extraction.fields.nationalityCode;delete p.extraction.fields.issuingCountryCode;
 const result=run([p,front()]),person=result.applicants[0];assert.equal(result.complete,true);assert.equal(person.fields.nationalityCode,'EGY');assert.equal(person.fields.issuingCountryCode,'UTO');assert.equal(person.evidence.nationalityCorroborated,true);
 for(const [field,line,positions]of [['nationalityCode',2,[11,13]],['issuingCountryCode',1,[3,5]]]){
  const source=person.evidence.fieldSources[field][0];assert.equal(source.method,'td3_zone_transcription');assert.equal(source.evidenceField,'mrzLines');assert.equal(source.line,line);assert.deepEqual(source.positions,positions);assert.equal(Object.hasOwn(source,'confidence'),false);assert.equal(Object.hasOwn(source,'checks'),false);
 }
});

test('MRZ nationality requires the exact case or matched identity value, and independent issuer never copies nationality',()=>{
 const p=passport();delete p.extraction.fields.nationalityCode;delete p.extraction.fields.issuingCountryCode;
 const id=front();delete id.extraction.fields.nationalityCode;
 const noCorroboration=run([p,id],[{}]).applicants[0];assert.equal(noCorroboration.fields.nationalityCode,'EGY');assert.equal(noCorroboration.evidence.nationalityCorroborated,false);assert.equal(noCorroboration.identityReady,false);assert.ok(noCorroboration.issues.some(issue=>issue.code==='DOCUMENT_FIELD_REQUIRED'&&issue.field==='nationalityCode'));
 assert.equal(run([p,id],[{nationality:'مصر'}]).complete,true);assert.equal(run([p,front()],[{}]).complete,true);
 const wrongCase=run([p,front()],[{nationality:'سوريا'}]);assert.equal(wrongCase.complete,false);assert.ok(codes(wrongCase).includes('CASE_DATA_MISMATCH'));
 const wrongIdentity=run([p,front({nationalityCode:'SYR'})]);assert.equal(wrongIdentity.complete,false);assert.ok(codes(wrongIdentity).includes('DOCUMENT_IDENTITY_MISMATCH'));
});

test('country transcription never overwrites a conflicting VIZ value or operates with a failed TD3 check',()=>{
 for(const field of ['nationalityCode','issuingCountryCode']){
  const p=passport();p.extraction.fields[field]=field==='nationalityCode'?{value:'SYR',confidence:1,visible:true}:{value:'SYR',confidence:1,visible:true};
  const result=run([p,front()]);assert.equal(result.complete,false);assert.equal(result.applicants[0].fields[field],'SYR');assert.ok(result.applicants[0].issues.some(issue=>issue.code==='PASSPORT_VIZ_MRZ_MISMATCH'&&issue.field===field));
 }
 for(const offset of [9,19,27,42,43]){
  const p=passport();delete p.extraction.fields.nationalityCode;delete p.extraction.fields.issuingCountryCode;const line=p.extraction.mrzLines[1];p.extraction.mrzLines[1]=line.slice(0,offset)+(Number(line[offset])+1)%10+line.slice(offset+1);
  const result=run([p,front()]);assert.equal(result.complete,false);assert.equal(result.applicants[0].fields.nationalityCode,undefined);assert.equal(result.applicants[0].fields.issuingCountryCode,undefined);
 }
});

test('private numeric evidence at .95 resolves only with whole checked national number and the unique full-year expiry intersection',()=>{
 const f=nationalDateCase();for(const field of ['passportNationalNumber','printedPassportExpiry'])f.datePage.extraction.fields[field].confidence=0.95;
 const result=run([f.p,f.datePage,f.id]),person=result.applicants[0];assert.equal(result.complete,true);assert.equal(person.fields.expiryDate,'2031-09-11');assert.equal(person.evidence.fieldSources.expiryDate[0].confidence,0.95);assert.equal(person.evidence.fieldSources.expiryDate[0].evidenceField,'printedPassportExpiry');assert.equal(person.fields.passportNationalNumber,undefined);assert.equal(person.fields.printedPassportExpiry,undefined);
 const boundary=nationalDateCase();for(const field of ['passportNationalNumber','printedPassportExpiry'])boundary.datePage.extraction.fields[field].confidence=0.90;assert.equal(run([boundary.p,boundary.datePage,boundary.id]).complete,true);
});

test('weaker private numeric evidence cannot link absent, wrong, meaningless, incomplete-year or nonintersecting passport data',()=>{
 for(const mutate of [
  f=>{delete f.datePage.extraction.fields.passportNationalNumber;},
  f=>{f.datePage.extraction.fields.passportNationalNumber.value='001-23456780';},
  f=>{f.datePage.extraction.fields.passportNationalNumber.value='0123456789';},
  f=>{f.datePage.extraction.fields.printedPassportExpiry.value='12/09/2031';},
  f=>{f.datePage.extraction.fields.printedPassportExpiry.value='11/09/31';},
  f=>{f.datePage.extraction.fields.passportNationalNumber.confidence=0.899;},
  f=>{f.datePage.extraction.fields.printedPassportExpiry.confidence=0.899;},
 ]){
  const f=nationalDateCase();for(const field of ['passportNationalNumber','printedPassportExpiry'])f.datePage.extraction.fields[field].confidence=0.95;mutate(f);
  const result=run([f.p,f.datePage,f.id]);assert.equal(result.complete,false);assert.equal(result.applicants[0].fields.expiryDate,undefined);assert.equal(result.applicants[0].documents.passportParts,undefined);
 }
 const zero=nationalDateCase();zero.p=withCheckedNationalOptional(zero.p,'00000000000<<<');zero.datePage.extraction.fields.passportNationalNumber=field('000-00000000',0.95);zero.datePage.extraction.fields.printedPassportExpiry.confidence=0.95;const result=run([zero.p,zero.datePage,zero.id]);assert.equal(result.complete,false);assert.equal(result.applicants[0].fields.expiryDate,undefined);
});

test('lower private threshold does not lower any government field threshold, supply issue date, infer names, or choose a century',()=>{
 const f=nationalDateCase();for(const field of ['passportNationalNumber','printedPassportExpiry'])f.datePage.extraction.fields[field].confidence=0.95;
 f.p.extraction.fields.issueDate.confidence=0.95;f.p.extraction.fields.passportType.confidence=0.95;f.p.extraction.fields.latinGrandfatherName=field('UNCONFIRMED',0.95);
 const person=run([f.p,f.datePage,f.id]).applicants[0];assert.equal(person.status,'needs_confirmation');assert.equal(person.fields.issueDate,undefined);assert.equal(person.fields.passportType,undefined);assert.equal(person.fields.latinGrandfatherName,undefined);assert.deepEqual(person.clientFieldsRequired,['passportType','issueDate']);
 const lowGov=passport();lowGov.extraction.fields.expiryDate.confidence=0.95;assert.equal(run([lowGov,front()]).applicants[0].fields.expiryDate,undefined);
 const direct=passport({expiryDate:'2031-09-11',printedPassportExpiry:'11/09/2031'});delete direct.extraction.fields.expiryDate;direct.extraction.fields.printedPassportExpiry.confidence=0.95;assert.equal(run([direct,front()]).applicants[0].fields.expiryDate,undefined,'low-confidence same-page expiry still needs the explicit whole national-number anchor');
});

function logicalMainDateCase(){
 const f=nationalDateCase();delete f.p.extraction.fields.nationalityCode;delete f.p.extraction.fields.issuingCountryCode;
 const copy=structuredClone(f.p);copy.mediaId=IDS.portrait;copy.sha256='c'.repeat(64);delete copy.extraction.fields.birthPlace;
 for(const field of ['passportNationalNumber','printedPassportExpiry'])f.datePage.extraction.fields[field].confidence=0.95;
 return {...f,copy};
}

test('different-pixel copies with identical checked MRZ select one covering main page plus the actual date page while retaining all source evidence',()=>{
 const f=logicalMainDateCase(),result=run([f.copy,f.datePage,f.id,f.p]),person=result.applicants[0];assert.equal(result.complete,true);assert.equal(person.fields.expiryDate,'2031-09-11');assert.equal(person.fields.nationalityCode,'EGY');assert.equal(person.fields.issuingCountryCode,'UTO');
 assert.deepEqual(person.documents.passportParts.map(ref=>ref.mediaId),[IDS.passport,IDS.passport2]);assert.equal(person.documents.passport.mediaId,IDS.passport);
 assert.deepEqual(person.evidence.passportLogicalDuplicates,[{representative:{mediaId:IDS.passport,page:1,sha256:'a'.repeat(64)},source:{mediaId:IDS.portrait,page:1,sha256:'c'.repeat(64)},method:'exact_checked_td3_same_visible_values'}]);
 assert.deepEqual(new Set(person.evidence.fieldSources.latinFirstName.map(source=>source.mediaId)),new Set([IDS.passport,IDS.portrait]));assert.equal(result.unassigned.length,0);assert.deepEqual(run([f.p,f.id,f.datePage,f.copy]),result);
});

test('logical main copies without a single actual page covering the critical union remain for review and never emit a sliced bundle',()=>{
 const f=logicalMainDateCase();f.copy=structuredClone(f.p);f.copy.mediaId=IDS.portrait;f.copy.sha256='c'.repeat(64);delete f.p.extraction.fields.birthPlace;delete f.copy.extraction.fields.issueDate;
 const result=run([f.p,f.copy,f.datePage,f.id]),person=result.applicants[0];assert.equal(result.complete,false);assert.equal(person.identityReady,false);assert.ok(codes(result).includes('MULTIPLE_PASSPORTS'));assert.equal(person.documents.passportParts,undefined);assert.equal(person.evidence.passportLogicalDuplicates,undefined);
});

test('logical duplicate handling never drops government, private numeric, legacy-number or literal MRZ contradictions',()=>{
 for(const mutate of [
  f=>{f.copy.extraction.fields.birthPlace=field('Different City');},
  f=>{f.p.extraction.fields.passportNationalNumber=field('001-23456789',0.95);f.copy.extraction.fields.passportNationalNumber=field('001-23456780',0.95);},
  f=>{f.copy.extraction.fields.passportNumber=field('N123456785');},
  f=>{f.copy.extraction.mrzLines[0]='PP'+f.copy.extraction.mrzLines[0].slice(2);},
 ]){
  const f=logicalMainDateCase();mutate(f);const result=run([f.p,f.copy,f.datePage,f.id]);assert.equal(result.complete,false);assert.equal(result.applicants[0].identityReady,false);assert.equal(result.applicants[0].evidence.passportLogicalDuplicates,undefined);
 }
 const f=logicalMainDateCase();f.p.extraction.fields.passportNationalNumber=field('001-23456789',0.95);f.copy.extraction.fields.passportNationalNumber=field('001-23456780',0.95);const two=run([f.p,f.copy,f.id]);assert.equal(two.complete,false);assert.ok(codes(two).includes('SOURCE_CONFLICT'));
});

test('identical unverified MRZ strings are not sufficient to coalesce main image copies',()=>{
 const f=logicalMainDateCase();const line=f.p.extraction.mrzLines[1];f.p.extraction.mrzLines[1]=line.slice(0,9)+(Number(line[9])+1)%10+line.slice(10);f.copy.extraction.mrzLines=structuredClone(f.p.extraction.mrzLines);
 const result=run([f.p,f.copy,f.datePage,f.id]);assert.equal(result.complete,false);assert.equal(result.applicants[0].evidence.passportLogicalDuplicates,undefined);
});

function residencePairTd1({number='X12345678',birth='900115',expiry='270430',eid='784190012345673',sex='F',nationality='EGY',name='EXAMPLE<<SYNTHETIC<PARENT'}={}){
 const first='I<ARE'+number+digit(number)+eid;
 const body=birth+digit(birth)+sex+expiry+digit(expiry)+nationality+'<'.repeat(11);
 return[first,body+digit(first.slice(5)+body.slice(0,7)+body.slice(8,15)+body.slice(18,29)),name.padEnd(30,'<')];
}
function residencePairCase({printedBackId=true,printedBackName=true,frontBirth=true}={}){
 const p=passport({latinFirstName:'SYNTHETIC',latinFatherName:'PARENT'}),id=front({latinFullName:'SYNTHETIC PARENT EXAMPLE'});
 if(!frontBirth)delete id.extraction.fields.birthDate;
 const back=document(IDS.back,'uae_id_back',{...(printedBackId?{emiratesId:'784190012345673'}:{}),...(printedBackName?{latinFullName:'SYNTHETIC PARENT EXAMPLE'}:{})},{mrzLines:residencePairTd1()});back.sha256='b'.repeat(64);
 return{p,id,back};
}

test('a proven printed-ID pair uses its front DOB for comparison without inventing a missing back DOB',()=>{
 const {p,id,back}=residencePairCase(),documents=[p,id,back],before=structuredClone(documents),result=run(documents),person=result.applicants[0];
 assert.equal(result.complete,true,JSON.stringify(person.issues));assert.equal(person.evidence.matchedResidence,true);assert.equal(person.documents.residence.length,2);assert.equal(result.unassigned.length,0);
 assert.equal(person.fields.birthDate,'1990-01-15');assert.deepEqual(documents,before);
 assert.equal(back.extraction.fields.birthDate,undefined);assert.equal(person.evidence.fieldSources.birthDate.some(source=>source.mediaId===IDS.back),false);
});

test('a closed checked TD1 pair assigns an unlabelled back and uses only the full passport DOB when the front abstains',()=>{
 for(const frontBirth of [true,false]){
  const {p,id,back}=residencePairCase({printedBackId:false,printedBackName:false,frontBirth}),documents=[back,id,p],before=structuredClone(documents),result=run(documents),person=result.applicants[0];
  assert.equal(result.complete,true,JSON.stringify({issues:person.issues,unassigned:result.unassigned}));assert.equal(person.documents.residence.length,2);assert.equal(result.unassigned.length,0);
  assert.equal(person.fields.birthDate,'1990-01-15');assert.equal(person.fields.emiratesId,'784190012345673');assert.equal(person.fields.latinFatherName,'PARENT');
  assert.equal(person.evidence.fieldSources.birthDate.every(source=>source.mediaId===IDS.passport),true);assert.equal(person.evidence.fieldSources.emiratesId.every(source=>source.mediaId===IDS.front),true);assert.deepEqual(documents,before);
 }
});

test('same explicit ID without MRZ can compare a missing back DOB only through an already assigned full-DOB front',()=>{
 const f=residencePairCase();f.back.extraction.mrzLines=[];const documents=[f.back,f.p,f.id],before=structuredClone(documents),result=run(documents);
 assert.equal(result.complete,true);assert.equal(result.unassigned.length,0);assert.deepEqual(documents,before);assert.equal(f.back.extraction.fields.birthDate,undefined);
 delete f.id.extraction.fields.birthDate;assert.equal(run(documents).complete,false);
 const noId=residencePairCase({printedBackId:false});noId.back.extraction.mrzLines=[];const unlinked=run([noId.p,noId.id,noId.back]);assert.equal(unlinked.complete,false);assert.ok(unlinked.unassigned.some(source=>source.mediaId===IDS.back));
});

test('closed residence pairs require exact whole ID, untruncated names, raw birth, sex and nationality on valid TD1 data',()=>{
 for(const options of [{eid:'784190012345674'},{birth:'910115'},{sex:'M'},{nationality:'SYR'},{name:'EXAMPLE<<SYNTHETIC<OTHER'},{name:'EXAMPLE<<SYNTHETIC<PARENT<ABCD'}]){
  const f=residencePairCase({printedBackId:false,printedBackName:false,frontBirth:false});f.back.extraction.mrzLines=residencePairTd1(options);
  const result=run([f.back,f.id,f.p]);assert.equal(result.complete,false,JSON.stringify(options));assert.equal(result.applicants[0].identityReady,false);assert.ok(result.unassigned.some(source=>source.mediaId===IDS.back));
 }
 for(const [line,position]of [[0,14],[1,6],[1,14],[1,29]]){
  const f=residencePairCase({printedBackId:false,printedBackName:false,frontBirth:false}),raw=f.back.extraction.mrzLines[line];f.back.extraction.mrzLines[line]=raw.slice(0,position)+(Number(raw[position])+1)%10+raw.slice(position+1);
  assert.equal(run([f.p,f.id,f.back]).complete,false);
 }
 const incomplete=residencePairCase({printedBackId:false,printedBackName:false,frontBirth:false});incomplete.back.extraction.mrzLines[0]=incomplete.back.extraction.mrzLines[0].slice(1);assert.equal(run([incomplete.p,incomplete.id,incomplete.back]).complete,false);
});

test('a checked pair never overrides printed DOB centuries, IDs, names, sex, nationality or passport contradictions',()=>{
 const mutations=[
  f=>{f.id.extraction.fields.birthDate=field('1890-01-15');},
  f=>{f.back.extraction.fields.birthDate=field('1890-01-15');},
  f=>{f.back.extraction.fields.birthDate=field('1990-01-16');},
  f=>{f.back.extraction.fields.emiratesId=field('784190012345674');},
  f=>{f.back.extraction.fields.emiratesId=field('78419001234567');},
  f=>{f.back.extraction.fields.emiratesId=field('784190012345674',0.95);},
  f=>{f.id.extraction.fields.latinFullName=field('SYNTHETIC OTHER EXAMPLE');},
  f=>{f.back.extraction.fields.latinFullName=field('SYNTHETIC OTHER EXAMPLE');},
  f=>{f.id.extraction.fields.sex=field('M');},
  f=>{f.back.extraction.fields.sex=field('M');},
  f=>{f.id.extraction.fields.nationalityCode=field('SYR');},
  f=>{f.back.extraction.fields.nationalityCode=field('SYR');},
  f=>{f.back.extraction.fields.passportNumber=field('OTHER1234');},
  f=>{delete f.id.extraction.fields.emiratesId;},
  f=>{delete f.p.extraction.fields.birthDate;},
  f=>{f.p.extraction.fields.latinFatherName.confidence=0.97;},
 ];
 for(const mutate of mutations){
  const f=residencePairCase({printedBackId:false,printedBackName:false,frontBirth:false});mutate(f);const before=structuredClone(f),result=run([f.p,f.id,f.back]);
  assert.equal(result.complete,false,mutate.toString());assert.equal(result.applicants[0].identityReady,false);assert.deepEqual(f,before);assert.equal(result.applicants[0].fields.birthDate==='1890-01-15',false);
 }
});

test('a closed pair cannot choose an applicant through conflicting passports with the same name and DOB',()=>{
 const f=residencePairCase({printedBackId:false,printedBackName:false,frontBirth:false}),second=passport({latinFirstName:'SYNTHETIC',latinFatherName:'PARENT',passportNumber:'X12345678'},IDS.passport2);second.sha256='c'.repeat(64);
 const result=run([f.p,f.id,f.back,second],[{nationality:'مصر',passportNumber:'N12345678'},{nationality:'مصر',passportNumber:'X12345678'}]);
 assert.equal(result.complete,false);assert.ok(result.applicants.every(person=>person.identityReady===false));assert.ok(result.unassigned.some(source=>source.mediaId===IDS.back));assert.ok(result.applicants.some(person=>person.issues.some(item=>item.code==='MULTIPLE_PASSPORTS')));
});

test('an exact-ID comparison cannot hide a contradictory partial name without a full name, DOB or MRZ',()=>{
 for(const [name,value]of [['latinFirstName','SYNTHETIC'],['latinFatherName','PARENT'],['latinFamilyName','EXAMPLE']]){
  const f=residencePairCase({printedBackName:false});f.back.extraction.mrzLines=[];f.back.extraction.fields[name]=field('OTHER');
  const documents=[f.p,f.id,f.back],before=structuredClone(documents),result=run(documents),person=result.applicants[0];
  assert.equal(result.complete,false,name);assert.equal(person.identityReady,false);assert.ok(person.issues.some(item=>item.code==='DOCUMENT_IDENTITY_MISMATCH'&&item.field===name));assert.equal(person.evidence.residencePairLinks,undefined);assert.deepEqual(documents,before);
  f.back.extraction.fields[name]=field(value);const consistent=run(documents);assert.equal(consistent.complete,true,name+' can be an explicit consistent partial observation');assert.equal(f.back.extraction.fields.birthDate,undefined);assert.equal(f.back.extraction.fields.latinFullName,undefined);
 }
});

function logicalResidenceBackCase(){
 const f=residencePairCase({printedBackId:false,printedBackName:false,frontBirth:false});
 delete f.p.extraction.fields.passportType;delete f.p.extraction.fields.issueDate;
 delete f.id.extraction.fields.residenceExpiry;f.id.extraction.fields.printedResidenceExpiry=field('30/04/2027');
 const copies=[IDS.front2,IDS.portrait].map((mediaId,index)=>{
  const copy=structuredClone(f.back);copy.mediaId=mediaId;copy.sha256=String(index+3).repeat(64);copy.extraction.fields.emiratesId=field('784190012345673',0.95);return copy;
 });
 return {...f,copies,documents:[f.p,f.id,f.back,...copies]};
}

test('three different-byte back images with exact checked TD1 and one strict printed-front identity select one actual back',()=>{
 const f=logicalResidenceBackCase(),before=structuredClone(f.documents),result=run(f.documents),person=result.applicants[0];
 assert.equal(person.identityReady,true,JSON.stringify(person.issues));assert.equal(person.status,'needs_confirmation');assert.deepEqual(person.clientFieldsRequired,['passportType','issueDate']);assert.equal(result.unassigned.length,0);
 assert.deepEqual(person.documents.residence.map(source=>source.mediaId),[IDS.front,IDS.back]);assert.equal(person.fields.residenceExpiry,'2027-04-30');
 assert.equal(person.evidence.residenceLogicalDuplicates.length,2);assert.deepEqual(new Set(person.evidence.residenceLogicalDuplicates.map(item=>item.source.mediaId)),new Set(f.copies.map(copy=>copy.mediaId)));
 assert.ok(person.evidence.residenceLogicalDuplicates.every(item=>item.front.mediaId===IDS.front&&item.representative.mediaId===IDS.back&&item.method==='exact_checked_td1_same_paired_identity_and_visible_values'));
 assert.deepEqual(new Set(person.evidence.residencePairLinks.map(item=>item.source.mediaId)),new Set([IDS.back,...f.copies.map(copy=>copy.mediaId)]));
 assert.ok(person.evidence.fieldSources.emiratesId.every(source=>source.mediaId===IDS.front));assert.ok(person.evidence.fieldSources.birthDate.every(source=>source.mediaId===IDS.passport));
 assert.deepEqual(f.documents,before);assert.deepEqual(run([...f.documents].reverse()),result);
});

test('logical back selection chooses an actual image covering the government union rather than highest confidence or latest ID',()=>{
 const f=logicalResidenceBackCase();f.back.extraction.fields.sex=field('F');f.copies[0].extraction.fields.nationalityCode=field('EGY');
 f.copies[1].extraction.fields.sex=field('F',0.98);f.copies[1].extraction.fields.nationalityCode=field('EGY',0.98);
 const result=run(f.documents),person=result.applicants[0];assert.equal(person.identityReady,true);assert.deepEqual(person.documents.residence.map(source=>source.mediaId),[IDS.front,f.copies[1].mediaId]);
 assert.ok(person.evidence.residenceLogicalDuplicates.every(item=>item.representative.mediaId===f.copies[1].mediaId));
});

test('complementary back facts without a covering real image never become a synthetic complete upload',()=>{
 const f=logicalResidenceBackCase();f.back.extraction.fields.sex=field('F');f.copies[0].extraction.fields.nationalityCode=field('EGY');
 const person=run(f.documents).applicants[0];assert.equal(person.identityReady,false);assert.equal(person.documents.residence.length,4);assert.ok(person.issues.some(item=>item.code==='RESIDENCE_CONFLICT'));assert.equal(person.evidence.residenceLogicalDuplicates,undefined);
});

test('logical back selection retains trusted contradictions in names, ID, full DOB, sex, nationality, expiry and rotation',()=>{
 for(const mutate of [
  f=>{f.copies[0].extraction.fields.latinFullName=field('SYNTHETIC OTHER EXAMPLE');},
  f=>{f.copies[0].extraction.fields.emiratesId=field('784190012345674');},
  f=>{f.copies[0].extraction.fields.birthDate=field('1890-01-15');},
  f=>{f.copies[0].extraction.fields.sex=field('M');},
  f=>{f.copies[0].extraction.fields.nationalityCode=field('SYR');},
  f=>{f.copies[0].extraction.fields.residenceExpiry=field('2028-04-30');},
  f=>{f.copies[0].extraction.fields.printedResidenceExpiry=field('01/05/2027');},
  f=>{f.copies[0].extraction.rotation=90;},
 ]){
  const f=logicalResidenceBackCase();mutate(f);const before=structuredClone(f.documents),result=run(f.documents),person=result.applicants[0];
  assert.equal(result.complete,false,mutate.toString());assert.ok(!person.identityReady||result.unassigned.length>0,mutate.toString());assert.deepEqual(f.documents,before);
  assert.ok(person.documents.residence.some(source=>source.mediaId===f.copies[0].mediaId)||result.unassigned.some(source=>source.mediaId===f.copies[0].mediaId),'A contradictory source must remain explicit or unassigned');
 }
});

test('different or invalid TD1 transcriptions cannot disappear as logical copies even with the same printed ID',()=>{
 for(const mutate of [
  f=>{f.copies[0].extraction.mrzLines=residencePairTd1({expiry:'280430'});},
  f=>{f.copies[0].extraction.mrzLines=residencePairTd1({number:'X12345679'});},
  f=>{const first=f.copies[0].extraction.mrzLines[0];f.copies[0].extraction.mrzLines[0]=first.slice(0,14)+(Number(first[14])+1)%10+first.slice(15);},
  f=>{f.copies[0].extraction.mrzLines[2]+='<';},
  f=>{f.copies[0].extraction.mrzLines=[];},
 ]){
  const f=logicalResidenceBackCase();f.copies[0].extraction.fields.emiratesId=field('784190012345673');mutate(f);const result=run(f.documents),person=result.applicants[0];
  assert.equal(person.identityReady,false);assert.ok(person.documents.residence.some(source=>source.mediaId===f.copies[0].mediaId)||result.unassigned.some(source=>source.mediaId===f.copies[0].mediaId));assert.equal((person.evidence.residenceLogicalDuplicates||[]).some(item=>item.source.mediaId===f.copies[0].mediaId),false);
 }
});

test('native-checked TD1 keeps a low-confidence raw ID uncertain while government ID remains the printed front value',()=>{
 for(const value of ['78419001234567','123456789','784190012345674']){
  const f=residencePairCase();f.back.mrzFocusStatus='checked';f.back.extraction.fields.emiratesId=field(value,0.95);f.back.extraction.fields.birthDate=field('1990-01-15');
  const documents=[f.p,f.id,f.back],before=structuredClone(documents),result=run(documents),person=result.applicants[0];
  assert.equal(result.complete,true,JSON.stringify(person.issues));assert.equal(person.identityReady,true);assert.equal(result.unassigned.length,0);
  assert.equal(person.fields.emiratesId,'784190012345673');assert.ok(person.evidence.fieldSources.emiratesId.every(source=>source.mediaId===IDS.front));assert.deepEqual(documents,before);
  assert.deepEqual(person.evidence.residenceUncertainIdObservations,[{mediaId:IDS.back,page:1,sha256:'b'.repeat(64),evidenceField:'emiratesId',confidence:0.95,method:'uncertain_raw_id_with_native_td1'}]);
 }
});

test('native evidence never overrides accepted ID conflicts or grants the low-confidence exception to an unverified source',()=>{
 for(const marker of [undefined,'original_checked','needs_review']){
  const f=residencePairCase();if(marker)f.back.mrzFocusStatus=marker;f.back.extraction.fields.emiratesId=field('123456789',0.95);f.back.extraction.fields.birthDate=field('1990-01-15');
  const person=run([f.p,f.id,f.back]).applicants[0];assert.equal(person.identityReady,false);assert.ok(person.issues.some(item=>item.code==='RESIDENCE_CONFLICT'));assert.equal(person.evidence.residenceUncertainIdObservations,undefined);
 }
 for(const value of ['784190012345674','78419001234567','123456789']){
  const f=residencePairCase();f.back.mrzFocusStatus='checked';f.back.extraction.fields.emiratesId=field(value,0.99);f.back.extraction.fields.birthDate=field('1990-01-15');
  const result=run([f.p,f.id,f.back]);assert.equal(result.complete,false);assert.equal(result.applicants[0].identityReady,false);assert.equal(result.applicants[0].evidence.residenceUncertainIdObservations,undefined);
 }
 const bad=residencePairCase();bad.back.mrzFocusStatus='checked';bad.back.extraction.fields.emiratesId=field('123456789',0.95);bad.back.extraction.fields.birthDate=field('1990-01-15');const line=bad.back.extraction.mrzLines[1];bad.back.extraction.mrzLines[1]=line.slice(0,29)+(Number(line[29])+1)%10;
 const person=run([bad.p,bad.id,bad.back]).applicants[0];assert.equal(person.identityReady,false);assert.ok(person.issues.some(item=>item.code==='RESIDENCE_MRZ_INVALID'));assert.equal(person.evidence.residenceUncertainIdObservations,undefined);
});

test('native-checked uncertain ID handling leaves every full DOB, sex, nationality and name conflict blocked',()=>{
 for(const [name,value]of [['birthDate','1890-01-15'],['sex','M'],['nationalityCode','SYR'],['latinFullName','SYNTHETIC OTHER EXAMPLE'],['latinFirstName','OTHER']]){
  const f=residencePairCase();f.back.mrzFocusStatus='checked';f.back.extraction.fields.emiratesId=field('123456789',0.95);f.back.extraction.fields.birthDate=field('1990-01-15');f.back.extraction.fields.passportNumber=field('N12345678');f.back.extraction.fields[name]=field(value);
  const before=structuredClone(f),result=run([f.p,f.id,f.back]);assert.equal(result.complete,false,name);assert.equal(result.applicants[0].identityReady,false);assert.deepEqual(f,before);
 }
});
