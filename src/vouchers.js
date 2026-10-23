'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {TERMS}=require('./flycham-pricing');
const {formatAED}=require('./money');
function oneYearFrom(ms){const d=new Date(ms+4*3600000),month=d.getUTCMonth();d.setUTCFullYear(d.getUTCFullYear()+1);if(d.getUTCMonth()!==month)d.setUTCDate(0);return d.getTime()-4*3600000;}
function durableMount(file){
 try {const target=path.resolve(file),lines=fs.readFileSync('/proc/self/mountinfo','utf8').split('\n');return lines.some(line=>{const mount=line.split(' ')[4]?.replace(/\\040/g,' ');return mount&&mount!=='/'&&mount!=='/tmp'&&(target===mount||target.startsWith(mount+'/'));});}catch{return false;}
}
class VoucherStore{
 constructor({file,key,now=Date.now,durable=false}={}){
  if(!file||!key)throw Error('VOUCHER_STORAGE_NOT_CONFIGURED');
  this.now=now;this.durable=durable;this.key=crypto.createHash('sha256').update(key).digest();
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const {DatabaseSync}=require('node:sqlite');this.db=new DatabaseSync(file);fs.chmodSync(file,0o600);
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS vouchers(id TEXT PRIMARY KEY, source TEXT UNIQUE NOT NULL, secret TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, value INTEGER NOT NULL, issued INTEGER NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('valid','used','cancelled')), redeemed INTEGER, redemption_ref TEXT);`);
 }
 encrypt(value){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',this.key,iv);return Buffer.concat([iv,c.update(JSON.stringify(value)),c.final(),c.getAuthTag()]).toString('base64');}
 decrypt(value){const b=Buffer.from(value,'base64'),d=crypto.createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));d.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]).toString());}
 public(row){if(!row)return null;return {id:row.id,value:formatAED(BigInt(row.value)),currency:'AED',issuedAt:new Date(row.issued).toISOString(),expiresAt:new Date(row.expires).toISOString(),state:row.state==='valid'&&row.expires<=this.now()?'expired':row.state};}
 issue({provider,tripType,bookingReference,customerName,ticketConfirmed,passengerReference}){
  if(provider!=='flycham'||!TERMS[tripType]||ticketConfirmed!==true)throw Error('VOUCHER_CONFIRMED_FLYCHAM_TICKET_REQUIRED');
  if(typeof customerName!=='string'||customerName.trim().length<2||customerName.length>80||/[\u0000-\u001f]/.test(customerName))throw Error('VOUCHER_NAME_INVALID');
  if(!/^[A-Za-z0-9-]{3,40}$/.test(bookingReference||'')||!/^[A-Za-z0-9-]{1,40}$/.test(passengerReference||''))throw Error('VOUCHER_BOOKING_REFERENCE_REQUIRED');
  const source=crypto.createHmac('sha256',this.key).update(provider+':'+bookingReference+':'+passengerReference).digest('hex');
  const old=this.db.prepare('SELECT * FROM vouchers WHERE source=?').get(source);
  if(old){const secret=this.decrypt(old.secret);if(secret.customerName!==customerName.trim()||secret.tripType!==tripType)throw Error('VOUCHER_ISSUE_CONFLICT');return {...this.public(old),...secret,existing:true};}
  const token=crypto.randomBytes(24).toString('base64url'),id=crypto.randomUUID(),issued=this.now(),expires=oneYearFrom(issued),secret={token,customerName:customerName.trim(),tripType};
  this.db.prepare('INSERT INTO vouchers(id,source,secret,token_hash,value,issued,expires,state) VALUES(?,?,?,?,?,?,?,?)').run(id,source,this.encrypt(secret),crypto.createHash('sha256').update(token).digest('hex'),Number(TERMS[tripType].voucher),issued,expires,'valid');
  return {...this.public(this.db.prepare('SELECT * FROM vouchers WHERE id=?').get(id)),...secret,existing:false};
 }
 lookup(token){if(!/^[A-Za-z0-9_-]{32}$/.test(token||''))return null;return this.public(this.db.prepare('SELECT * FROM vouchers WHERE token_hash=?').get(crypto.createHash('sha256').update(token).digest('hex')));}
 get(id){const row=this.db.prepare('SELECT * FROM vouchers WHERE id=?').get(id);return row?{...this.public(row),...this.decrypt(row.secret)}:null;}
 redeem(id,reference){if(typeof reference!=='string'||reference.trim().length<3||reference.length>100)throw Error('VOUCHER_REDEMPTION_REFERENCE_REQUIRED');const result=this.db.prepare("UPDATE vouchers SET state='used',redeemed=?,redemption_ref=? WHERE id=? AND state='valid' AND expires>?").run(this.now(),this.encrypt({reference:reference.trim()}),id,this.now());if(result.changes!==1)throw Error('VOUCHER_NOT_REDEEMABLE');return this.public(this.db.prepare('SELECT * FROM vouchers WHERE id=?').get(id));}
 cancel(id){const r=this.db.prepare("UPDATE vouchers SET state='cancelled' WHERE id=? AND state='valid'").run(id);if(r.changes!==1)throw Error('VOUCHER_NOT_CANCELLABLE');return this.public(this.db.prepare('SELECT * FROM vouchers WHERE id=?').get(id));}
 overview(){
  const stamp=this.now(),counts=this.db.prepare("SELECT count(*) totalCount, coalesce(sum(CASE WHEN state='valid' AND expires>? THEN 1 ELSE 0 END),0) validCount, coalesce(sum(CASE WHEN state='used' THEN 1 ELSE 0 END),0) usedCount, coalesce(sum(CASE WHEN state='valid' AND expires>? THEN value ELSE 0 END),0) validValue FROM vouchers").get(stamp,stamp);
  const items=this.db.prepare('SELECT * FROM vouchers ORDER BY issued DESC,id DESC LIMIT 100').all().map(row=>{const secret=this.decrypt(row.secret);return{...this.public(row),customerName:secret.customerName,tripType:secret.tripType};});
  return {ready:true,updatedAt:new Date(stamp).toISOString(),summary:{...counts,validValue:formatAED(BigInt(counts.validValue))},items};
 }
 close(){this.db.close();}
}
let active;
function configuredStore(env=process.env){if(!env.VOUCHER_DB_PATH||!env.VOUCHER_ENCRYPTION_KEY||!durableMount(env.VOUCHER_DB_PATH))throw Error('VOUCHER_DURABLE_STORAGE_REQUIRED');return active||(active=new VoucherStore({file:env.VOUCHER_DB_PATH,key:env.VOUCHER_ENCRYPTION_KEY,durable:true}));}
module.exports={VoucherStore,configuredStore,durableMount,oneYearFrom};
