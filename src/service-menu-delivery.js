'use strict';
const {incomingRevision}=require('./service-routing');
function createServiceMenuSender({store,inbox,send,journal}){
 return async function sendServiceMenu(sender,route,revision){
  // Called from the serialized inbound handler. Do not join the outbound queue:
  // price deliveries on that queue may be waiting for this handler to settle.
  const session=store.data.serviceSessions?.[sender];
  if(inbox.isHumanOwned(sender)||incomingRevision(store,sender)!==revision||!session?.awaitingService||session.menuId!==route.menuId)return;
  const result=await send(sender,{text:route.reply,menuId:route.menuId}),id=result?.messages?.[0]?.id;
  if(id&&journal.hasCustomer(sender))journal.recordOutbound(sender,{id,text:route.reply,actor:'assistant',timestamp:Date.now(),status:'accepted'});
  return result;
 };
}
module.exports={createServiceMenuSender};
