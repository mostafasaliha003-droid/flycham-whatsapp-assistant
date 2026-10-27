'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');const{loadVisaPrivateConfig}=require('../src/saudi-visa-private');
test('business bank/contact configuration is private encrypted and fails closed with wrong key',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'visa-private-')),file=path.join(dir,'private.enc'),key='synthetic-key';try{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update(key).digest(),iv);const data={banks:[{bank:'Synthetic Bank',name:'Synthetic Company',account:'00000001',iban:'AE000000000000000000000'}],complaintRecipient:'971500000005'};const ciphertext=Buffer.concat([c.update(JSON.stringify(data)),c.final()]);fs.writeFileSync(file,Buffer.concat([iv,c.getAuthTag(),ciphertext]));assert.deepEqual(loadVisaPrivateConfig({file,env:{ASSISTANT_STATE_KEY:key}}),data);assert.deepEqual(loadVisaPrivateConfig({file,env:{ASSISTANT_STATE_KEY:'wrong'}}),{});assert.equal(fs.readFileSync(file).includes(Buffer.from(data.banks[0].iban)),false);}finally{fs.rmSync(dir,{recursive:true,force:true});}});

function encryptedConfig(t,data){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'raad-private-')),file=path.join(dir,'private.enc'),key='synthetic-private-raad-key';t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update(key).digest(),iv),encrypted=Buffer.concat([cipher.update(JSON.stringify(data)),cipher.final()]);fs.writeFileSync(file,Buffer.concat([iv,cipher.getAuthTag(),encrypted]));
 return{file,key,read:()=>loadVisaPrivateConfig({file,env:{ASSISTANT_STATE_KEY:key}})};
}

test('optional RAAD contacts remain encrypted and return only trimmed supported configuration fields',t=>{
 const raad={applicationPhone:' +971500000090 ',contactEmail:' synthetic-raad@example.invalid ',insurancePhone:' +971500000091 ',city:' Synthetic City ',postalCode:' 00000 ',postOfficeBox:' 12345 ',password:'SYNTHETIC_PASSWORD',otp:'SYNTHETIC_OTP',portalCookie:'SYNTHETIC_COOKIE'};
 const fixture=encryptedConfig(t,{raad}),result=fixture.read();
 assert.deepEqual(result,{banks:[],complaintRecipient:null,raad:{applicationPhone:'+971500000090',contactEmail:'synthetic-raad@example.invalid',insurancePhone:'+971500000091',city:'Synthetic City',postalCode:'00000',postOfficeBox:'12345'}});
 const bytes=fs.readFileSync(fixture.file);assert.equal(bytes.includes(Buffer.from('synthetic-raad@example.invalid')),false);assert.equal(bytes.includes(Buffer.from('+971500000090')),false);
 assert.deepEqual(loadVisaPrivateConfig({file:fixture.file,env:{ASSISTANT_STATE_KEY:'synthetic-wrong-key'}}),{});
});

test('malformed optional RAAD values are omitted without changing the old bank/contact contract',t=>{
 const fixture=encryptedConfig(t,{raad:{applicationPhone:'synthetic\rheader',contactEmail:'synthetic\n@example.invalid',insurancePhone:'\u0000synthetic',city:{name:'Synthetic City'},postalCode:'x'.repeat(161),postOfficeBox:12345,password:'SYNTHETIC_PASSWORD'}});
 assert.deepEqual(fixture.read(),{banks:[],complaintRecipient:null});
 for(const raad of [null,[],false,'unsupported'])assert.deepEqual(encryptedConfig(t,{raad}).read(),{banks:[],complaintRecipient:null});
});

test('optional TinyFish profile identifiers are strictly whitelisted and remain encrypted without passing through access keys',t=>{
 const banks=[{bank:'Synthetic Bank',name:'Synthetic Company',account:'00000001',iban:'AE000000000000000000000'}],complaintRecipient='971500000005';
 const fixture=encryptedConfig(t,{banks,complaintRecipient,tinyfishAccessKey:'SYNTHETIC_ACCESS_KEY',TINYFISH_API_KEY:'SYNTHETIC_ACCESS_KEY',raad:{tinyfishProfileId:'prof_test123',contactEmail:' synthetic-raad@example.invalid ',tinyfishAccessKey:'SYNTHETIC_ACCESS_KEY',tinyfishApiKey:'SYNTHETIC_ACCESS_KEY',apiKey:'SYNTHETIC_ACCESS_KEY',accessKey:'SYNTHETIC_ACCESS_KEY',TINYFISH_API_KEY:'SYNTHETIC_ACCESS_KEY'}});
 const result=fixture.read();
 assert.deepEqual(result,{banks,complaintRecipient,raad:{contactEmail:'synthetic-raad@example.invalid',tinyfishProfileId:'prof_test123'}});
 assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_ACCESS_KEY|accessKey|apiKey|API_KEY/i);
 assert.equal(fs.readFileSync(fixture.file).includes(Buffer.from('prof_test123')),false);
 for(const tinyfishProfileId of ['prof_test_A-1','prof_'+'a'.repeat(120)])assert.equal(encryptedConfig(t,{raad:{tinyfishProfileId}}).read().raad.tinyfishProfileId,tinyfishProfileId);
});

test('malformed TinyFish profile identifiers are ignored without trimming, coercion or access-key fallback',t=>{
 for(const tinyfishProfileId of ['', 'prof_', 'PROF_test123', 'profile_test123', 'prof_test.123', 'prof_test/123', 'prof_test:123', ' prof_test123', 'prof_test123 ', 'prof_test123\n', 'prof_test123\r\n', 'prof_test\t123', 'prof_'+'a'.repeat(121), null, true, 123, {}, []]){
  const result=encryptedConfig(t,{tinyfishAccessKey:'SYNTHETIC_ACCESS_KEY',raad:{tinyfishProfileId,accessKey:'SYNTHETIC_ACCESS_KEY'}}).read();
  assert.deepEqual(result,{banks:[],complaintRecipient:null});
 }
});
