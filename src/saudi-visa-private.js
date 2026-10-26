'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {defaultStateFile}=require('./state-storage');
// Business financial/contact data is provisioned privately, never in source control.
function loadVisaPrivateConfig({env=process.env,file}={}){
 try{
  const state=env.ASSISTANT_STATE_PATH||defaultStateFile(),target=file||env.SAUDI_VISA_PRIVATE_PATH||(state&&path.join(path.dirname(state),'saudi-visa-private.enc'));
  const key=env.ASSISTANT_STATE_KEY||env.WHATSAPP_APP_SECRET;if(!target||!key||!fs.existsSync(target))return{};
  const b=fs.readFileSync(target);if(b.length>20000||b.length<29)return{};
  const d=crypto.createDecipheriv('aes-256-gcm',crypto.createHash('sha256').update(key).digest(),b.subarray(0,12));d.setAuthTag(b.subarray(12,28));
  const config=JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());
  const banks=Array.isArray(config.banks)?config.banks.filter(x=>x&&['bank','name','account','iban'].every(k=>typeof x[k]==='string'&&x[k].length>0&&x[k].length<120)&&/^AE\d{21}$/.test(x.iban)&&/^\d{5,30}$/.test(x.account)).slice(0,5):[];
  const complaintRecipient=/^\d{8,15}$/.test(config.complaintRecipient||'')?config.complaintRecipient:null;
  return{banks,complaintRecipient};
 }catch{return{};}
}
module.exports={loadVisaPrivateConfig};
