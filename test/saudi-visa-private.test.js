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
