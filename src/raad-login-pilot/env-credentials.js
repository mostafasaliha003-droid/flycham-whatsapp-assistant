'use strict';
function credentialConfig(env){const username=env.RAAD_MOFA_USERNAME,password=env.RAAD_MOFA_PASSWORD;const any=Boolean(username||password),configured=typeof username==='string'&&username.trim().length>0&&username.length<=254&&typeof password==='string'&&password.length>0&&password.length<=256;return {configured,incomplete:any&&!configured};}
function getCredentials(env,input={}){const state=credentialConfig(env);if(state.incomplete)throw Error('ENV_CREDENTIALS_INCOMPLETE');if(state.configured)return {username:env.RAAD_MOFA_USERNAME,password:env.RAAD_MOFA_PASSWORD};return {username:input.username,password:input.password};}
module.exports={credentialConfig,getCredentials};
