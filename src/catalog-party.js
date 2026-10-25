'use strict';
const FIXTURES=Object.freeze([
 {id:'adult',label:'بالغ واحد',passengers:{adults:1,children:0,infants:0,ages:[]}},
 {id:'adult_child7',label:'بالغ مع طفل عمره سبع سنوات',passengers:{adults:1,children:1,infants:0,ages:[7]}},
 {id:'adult_infant1',label:'بالغ مع رضيع عمره سنة',passengers:{adults:1,children:0,infants:1,ages:[1]}},
]);
function partyKey(p={adults:1,children:0,infants:0,ages:[]}){return JSON.stringify([p.adults,p.children,p.infants,p.ages||[]]);}
function fixtureFor(p){return FIXTURES.find(f=>partyKey(f.passengers)===partyKey(p));}
function catalogParties({familyEnabled=false,verified=false}={}){return structuredClone(familyEnabled&&verified?FIXTURES:[FIXTURES[0]]);}
module.exports={CATALOG_PARTY_FIXTURES:FIXTURES,partyKey,fixtureFor,catalogParties};
