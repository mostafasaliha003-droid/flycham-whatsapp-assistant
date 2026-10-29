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
  assert.equal(person.evidence.authenticityVerified,false); assert.equal(person.evidence.fieldSources.passportNumber[0].method,'visible_and_mrz_checked');
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
  for(const key of ['passportNumber','nationalityCode','birthDate','expiryDate','latinFirstName']){
    const p=passport(); delete p.extraction.fields[key]; const person=run([p,front()]).applicants[0];
    assert.equal(person.identityReady,false,key); assert.equal(person.status,'needs_review',key); assert.deepEqual(person.clientFieldsRequired,[],key);
  }
});

test('valid-looking visual values do not repair failed MRZ check digits', () => {
  const p=passport(); p.extraction.mrzLines[1]=p.extraction.mrzLines[1].slice(0,9)+'0'+p.extraction.mrzLines[1].slice(10);
  const result=run([p,front()]); assert.equal(result.complete,false); assert.ok(codes(result).includes('PASSPORT_MRZ_INVALID')); assert.equal(result.applicants[0].evidence.passportMrzChecked,false);
});

test('valid MRZ for a different document cannot override mismatched visible passport data', () => {
  const p=passport(); p.extraction.mrzLines=mrz({passportNumber:'X12345678'});
  const result=run([p,front()]); assert.equal(result.complete,false); assert.ok(result.applicants[0].issues.some(item=>item.code==='PASSPORT_VIZ_MRZ_MISMATCH'&&item.field==='passportNumber'));
  assert.equal(result.applicants[0].fields.passportNumber,'N12345678');
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
  const result=run([passport(),second,third,front()]); assert.equal(result.complete,false); assert.equal(result.applicants[0].documents.passportParts.length,2);
  assert.ok(codes(result).includes('MULTIPLE_PASSPORTS')); assert.equal(result.unassigned.length,1);
});

test('byte-identical reuploads deduplicate passport and identity pages while distinct page images remain linked', () => {
  const p=passport(),p2=passport({},IDS.passport2),f=front(),f2=front({},IDS.front2);
  const result=run([p2,f2,p,f]); assert.equal(result.complete,true); assert.equal(result.applicants[0].documents.passportParts,undefined);
  assert.equal(result.applicants[0].documents.residence.length,1); assert.equal(result.applicants[0].documents.residence[0].mediaId,IDS.front);
  assert.equal(result.applicants[0].evidence.fieldSources.passportNumber.length,1);
  p2.sha256='b'.repeat(64); const distinct=run([p,p2,f]); assert.equal(distinct.complete,true); assert.equal(distinct.applicants[0].documents.passportParts.length,2);
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
