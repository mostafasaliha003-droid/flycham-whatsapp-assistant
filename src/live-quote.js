'use strict';
const {toFils,formatAED,MAX_FILS}=require('./money');
const {addDays,iso}=require('./arabic-dates');
const airports=new Map([['SHJ','SHJ'],['الشارقة','SHJ'],['الشارقه','SHJ'],['Sharjah','SHJ'],['DAM','DAM'],['دمشق','DAM'],['Damascus','DAM']].map(([a,b])=>[a.toLowerCase(),b]));
function validateLiveRequest(r,now=Date.now()){
  const origin=airports.get(String(r?.origin||'').trim().toLowerCase()),destination=airports.get(String(r?.destination||'').trim().toLowerCase());
  const validDate=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'') && new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
  if(!origin || !destination || origin===destination || !['round_trip','one_way'].includes(r.tripType) || !validDate(r.departureDate) || (r.tripType==='round_trip'&&!validDate(r.returnDate))
    || r.departureDate<new Date(now).toISOString().slice(0,10) || (r.tripType==='round_trip'&&r.returnDate<r.departureDate)
    || r.passengers?.adults!==1 || r.passengers.children!==0 || r.passengers.infants!==0)throw Error('LIVE_SCOPE_UNSUPPORTED');
  if(r.baggageRequest && (!Number.isFinite(r.baggageRequest.checkedWeightKg)||r.baggageRequest.checkedWeightKg<=0||r.baggageRequest.checkedWeightKg>100||r.baggageRequest.requestedByCustomer!==true))throw Error('LIVE_SCOPE_UNSUPPORTED');
  return{origin,destination,departureDate:r.departureDate.split('-').reverse().join('/'),returnDate:r.tripType==='round_trip'?r.returnDate.split('-').reverse().join('/'):null};
}
function quoteFromScans(request,seats,catalogs){
  validateLiveRequest(request);
  const legs=seats?.segments;
  if(!seats?.complete || !catalogs?.complete || !legs?.length || catalogs.provisionalTotal?.base?.currency!=='AED'
    || catalogs.feeAudit?.amounts?.ancillaryTotal!=='0.00')throw Error('PRICE_NOT_VERIFIED');
  const seatIds=new Set(legs.map(s=>s.segment));if(seatIds.size!==legs.length)throw Error('PRICE_NOT_VERIFIED');
  let supplier=toFils(catalogs.provisionalTotal.base.amount,'Portal total'),margin=2500n;
  const weights=[];let baggageUpgrade=false;
  for(const leg of legs){if(!leg.complete || !leg.cheapestOrdinarySeat || leg.cheapestOrdinarySeat.currency!=='AED')throw Error('PRICE_NOT_VERIFIED');const seat=toFils(leg.cheapestOrdinarySeat.amount,'Seat');supplier+=seat;if(seat>0n)margin+=1000n;}
  for(const type of ['meal','baggage']){
    const group=catalogs.results.find(r=>r.type===type);if(!group?.complete)throw Error('PRICE_NOT_VERIFIED');
    const covered=new Set();
    for(const c of group.catalogs){
      if(!c.complete || c.classificationsComplete!==true || !c.coveredSegments?.length || c.coveredSegments.some(id=>!seatIds.has(id)))throw Error('PRICE_NOT_VERIFIED');
      // Shared OND groups are one supplier offer, never double charged.
      if(c.coveredSegments.every(id=>covered.has(id)))continue;
      if(c.coveredSegments.some(id=>covered.has(id)))throw Error('PRICE_NOT_VERIFIED');
      c.coveredSegments.forEach(id=>covered.add(id));
      const options=c.options.filter(o=>o.available===true&&o.price?.currency==='AED'&&(type!=='meal'||o.foodKind==='food')).sort((a,b)=>a.price.amount-b.price.amount);
      const baseline=options[0];
      const selected=type==='baggage'&&request.baggageRequest?options.find(o=>o.checkedWeightKg>=request.baggageRequest.checkedWeightKg):baseline;
      if(!selected)throw Error('PRICE_NOT_VERIFIED');
      const cost=toFils(selected.price.amount,'Service');supplier+=cost;
      if(type==='meal'&&cost>0n)margin+=500n;
      if(type==='baggage'){
        baggageUpgrade ||= Boolean(request.baggageRequest && selected.checkedWeightKg>baseline.checkedWeightKg);
        weights.push({segments:c.coveredSegments,kg:selected.checkedWeightKg});
      }
    }
    if(covered.size!==seatIds.size)throw Error('PRICE_NOT_VERIFIED');
  }
  if(baggageUpgrade)margin+=1000n;
  if(supplier+margin>MAX_FILS)throw Error('PRICE_NOT_VERIFIED');
  return{currency:'AED',sellingTotal:formatAED(supplier+margin),weights};
}
function formatLiveQuote(request,price){return `السعر المتاح لشخص بالغ واحد من ${request.origin} إلى ${request.destination}، ذهابًا وعودة:\nالذهاب: ${request.departureDate}\nالعودة: ${request.returnDate}\nالإجمالي: ${price.sellingTotal} درهم، شامل الرسوم وعمولة الخدمة.\nالوزن المسجل: ${price.weights.map(w=>w.kg+' كغ').join(' / ')} حسب اتجاه الرحلة.\nوزن اليد غير مؤكد في هذا العرض. السعر والتوفر قابلان للتغير حتى إصدار التذكرة. لم يتم إجراء حجز.`;}
function expandLiveRequests(request){
 if(!request.departureRange){validateLiveRequest(request);return [request];}
 const {start,end}=request.departureRange;
 const first=new Date(start+'T00:00:00Z'),last=new Date(end+'T00:00:00Z');
 if(!Number.isFinite(+first)||!Number.isFinite(+last)||iso(first)!==start||iso(last)!==end||last<first||last-first>31*86400000)throw Error('LIVE_SCOPE_UNSUPPORTED');
 const dates=[];
 for(let d=first;d<=last;d=addDays(d,1)){
  const candidate={...request,departureDate:iso(d),departureRange:null,returnDate:request.tripType==='one_way'?null:request.stayNights?iso(addDays(d,request.stayNights)):request.returnDate};
  validateLiveRequest(candidate);dates.push(candidate);
 }
 return dates;
}
function formatQuoteOptions(request,results,{complete,attempted,totalDates}={}){
 if(!results.length)return 'تعذر تأكيد أسعار التواقيت المطلوبة. يرجى مراجعة موظف المبيعات؛ لم يتم إجراء حجز.';
 const sorted=results.slice().sort((a,b)=>Number(a.price.sellingTotal)-Number(b.price.sellingTotal));
 const shown=request.resultsMode==='summary'?sorted.slice(0,3):results;
 const title=request.departureRange?`نتائج المقارنة ضمن ${request.departureRange.start} إلى ${request.departureRange.end}`:'أسعار الرحلات التي تم فحصها';
 return `${title} — لشخص بالغ واحد، ${request.tripType==='one_way'?'ذهاب فقط':'ذهاب وعودة'}:\n`+shown.map((q,i)=>`${i+1}) الذهاب ${q.request?.departureDate||request.departureDate||''} — ${q.timing.out.flight}: ${q.timing.out.departure} ← الوصول ${q.timing.out.arrival}${q.timing.back?`\nالعودة ${q.request?.returnDate||request.returnDate||''} — ${q.timing.back.flight}: ${q.timing.back.departure} ← الوصول ${q.timing.back.arrival}`:''}\nالإجمالي ${q.price.sellingTotal} درهم؛ الوزن ${q.price.weights.map(w=>w.kg+' كغ').join(' / ')}${q.price.sellingTotal===sorted[0].price.sellingTotal?' — الأقل بين النتائج المعروضة':''}`).join('\n\n')
  +`\n\n${complete?'اكتمل فحص التواقيت المتاحة في نتائج البحث.':'الفحص جزئي؛ لا نؤكد أن هذه أرخص أسعار كامل الفترة أو أن جميع التواقيت فُحصت.'}\nتمت محاولة فحص ${attempted} خيارًا؛ فترة الطلب تضم ${totalDates} تاريخًا. الأسعار تشمل الرسوم والعمولة. المواعيد كما تظهر في البوابة. وزن اليد غير مؤكد. السعر والتوفر قابلان للتغير؛ لم يتم حجز أي تذكرة.`;
}
module.exports={validateLiveRequest,quoteFromScans,formatLiveQuote,expandLiveRequests,formatQuoteOptions};
