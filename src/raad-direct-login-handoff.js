'use strict';
// Isolated prototype. Not wired into production; caller must authenticate and
// provide a secure private transport. Never persist screenshots or credentials.
const {chromium}=require('playwright');
const LOGIN='https://visa.mofa.gov.sa/Account/Loginindividuals';
const FIELDS={user:'#myform #UserName',password:'#myform #Password',captcha:'#myform #Captcha',image:'#myform #imgCaptcha',submit:'#myform #btnSubmit'};
async function openHandoff({launch=chromium.launch.bind(chromium),timeoutMs=120000}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<10000||timeoutMs>300000)throw Error('INVALID_TIMEOUT');
 const browser=await launch({headless:true,args:['--no-sandbox']});let page,closed=false,submitted=false,timer;
 async function close(){if(closed)return;closed=true;clearTimeout(timer);await browser.close();}
 async function guard(){if(closed||!page||page.isClosed()||!browser.isConnected())throw Error('SESSION_CLOSED');const u=new URL(page.url());if(u.protocol!=='https:'||u.hostname!=='visa.mofa.gov.sa')throw Error('UNTRUSTED_PAGE');}
 try{page=await browser.newPage();await page.goto(LOGIN,{waitUntil:'domcontentloaded',timeout:45000});await guard();for(const sel of Object.values(FIELDS)){const l=page.locator(sel);if(await l.count()!==1||!await l.isVisible())throw Error('LOGIN_FORM_UNAVAILABLE');}timer=setTimeout(()=>{void close().catch(()=>{});},timeoutMs);timer.unref?.();}
 catch(e){await close().catch(()=>{});throw e;}
 return {
  async image(){await guard();if(submitted)throw Error('ALREADY_SUBMITTED');return page.locator(FIELDS.image).screenshot({type:'png'});},
  async submit({username,password,captcha}){await guard();if(submitted)throw Error('ALREADY_SUBMITTED');if(typeof username!=='string'||typeof password!=='string'||typeof captcha!=='string'||!username.trim()||!password||!captcha.trim()||username.length>254||password.length>256||captcha.length>32)throw Error('INVALID_INPUT');submitted=true;try{await page.locator(FIELDS.user).fill(username);await page.locator(FIELDS.password).fill(password);await page.locator(FIELDS.captcha).fill(captcha);await page.locator(FIELDS.submit).click({timeout:10000});return {submitted:true,authenticated:false,reason:'AUTHENTICATION_UNVERIFIED'};}catch{await close().catch(()=>{});throw Error('SUBMISSION_FAILED');}},
  close
 };
}
module.exports={openHandoff};
