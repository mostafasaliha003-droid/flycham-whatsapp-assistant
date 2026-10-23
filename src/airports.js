'use strict';
// Search candidates, not a promise that either supplier operates this route.
// The portal must confirm its autocomplete selection and exact result itinerary.
const AIRPORTS=Object.freeze({SHJ:'SHJ - Sharjah',DAM:'DAM - Damascus',ALP:'ALP - Aleppo',DXB:'DXB - Dubai',AUH:'AUH - Abu Dhabi',DWC:'DWC - Al Maktoum'});
const aliases={DXB:['DXB','Dubai','دبي','مطار دبي','دبي الدولي'],AUH:['AUH','Abu Dhabi','أبوظبي','ابوظبي','ابو ظبي','أبو ظبي','زايد الدولي'],DWC:['DWC','Al Maktoum','Dubai World Central','آل مكتوم','ال مكتوم','المكتوم','مطار آل مكتوم','مطار ال مكتوم','دبي وورلد سنترال'],SHJ:['SHJ','Sharjah','الشارقة','الشارقه','شارقة','شارقه','شارجة','شارجه','شارق'],DAM:['DAM','Damascus','دمشق','الشام','شام'],ALP:['ALP','Aleppo','حلب','حلاب']};
const codes=new Map(Object.entries(aliases).flatMap(([code,names])=>names.map(name=>[name.trim().toLowerCase(),code])));
const airportCode=value=>codes.get(String(value||'').trim().toLowerCase());
module.exports={AIRPORTS,airportCode};
