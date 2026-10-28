'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createPortalDateState}=require('./portal-date-state');
const traditional='/SmartForm/TraditionalApp',health='/SmartForm/HealthInsuranceInfo/123456';
test('application dates cannot contaminate an insurance form or another application',()=>{
 const state=createPortalDateState(),passport={id:'PASSPORT_ISSUE_DATE',isoDate:'2030-03-15'},entry={id:'ExpectedEntryDate',isoDate:'2032-07-09'};
 state.begin(traditional,[passport,entry]);state.complete(traditional,[passport,entry]);
 assert.deepEqual(state.submission(traditional),{pending:false,dates:[passport,entry]});
 assert.deepEqual(state.submission(health),{pending:true,dates:[]});
 state.begin(health,[entry]);state.complete(health,[entry]);
 assert.deepEqual(state.submission(health),{pending:false,dates:[entry]});
 assert.deepEqual(state.submission('/SmartForm/HealthInsuranceInfo/654321'),{pending:true,dates:[]});
});
test('partial widget failures remain blocked until that form batch is confirmed',()=>{
 const state=createPortalDateState(),entry={id:'ExpectedEntryDate',isoDate:'2032-07-09'};
 state.begin(health,[entry]);assert.equal(state.submission(health).pending,true);
 state.complete(health,[entry]);assert.equal(state.submission(health).pending,false);
 state.begin(health,[{...entry,isoDate:'invalid'}]);assert.equal(state.submission(health).pending,true);
 assert.deepEqual(state.submission(traditional),{pending:false,dates:[]});
});
test('insurance expectations only accept its actual entry date and return defensive copies',()=>{
 const state=createPortalDateState(),entry={id:'ExpectedEntryDate',isoDate:'2032-07-09'};
 assert.throws(()=>state.complete(health,[{id:'BIRTH_DATE',isoDate:'2000-01-01'}]),/UNCONFIRMED/);
 state.begin(health,[entry]);state.complete(health,[entry]);
 state.submission(health).dates[0].isoDate='2000-01-01';assert.equal(state.submission(health).dates[0].isoDate,entry.isoDate);
});
