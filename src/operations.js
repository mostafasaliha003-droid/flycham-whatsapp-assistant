'use strict';
const field=document.getElementById('key'),error=document.getElementById('error');let refresh,busy=false;
const labels={pending:'بانتظار الموظف',notified:'تم إشعار الحجوزات',claimed:'قيد متابعة الموظف',released:'أعيد للمساعد',issued:'تم تسجيل الإصدار'};
async function call(path,method='GET',body){const r=await fetch('/internal/assistant/'+path,{method,headers:{Authorization:'Bearer '+field.value,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store'});if(!r.ok)throw Error('تعذر الوصول. تأكد من مفتاح الإدارة وإعداد الخدمة.');return r.json();}
const line=(label,value)=>{const p=document.createElement('p');p.textContent=label+': '+(value??'—');return p;};
async function load(){if(busy)return;busy=true;try{
 error.textContent='';const data=await call('status'),area=document.getElementById('status');area.replaceChildren();
 const title=document.createElement('h2');title.textContent='حالة أحمد ونتائج المبيعات';area.append(title);
 area.append(line('مدير المحادثة',data.consultant?.enabled?'مفعّل':'غير مفعّل'),line('البحث الخارجي',data.consultant?.webResearchConfigured?'مهيأ للمصادر الرسمية':'غير مهيأ؛ لا تُعرض معلومات كأنها بحث مؤكد'));
 const metrics=data.consultant?.metrics,counts=metrics?.counts||{},grid=document.createElement('div');grid.className='metrics';
 for(const [label,value]of [['طلبات البحث',counts.search_queued||0],['رحلات وصلها عرض مؤكد',counts.first_offer||0],['طلبات تثبيت',counts.handoff||0],['استلمها الموظف',counts.claimed||0],['إصدارات مؤكدة من الموظف',counts.issued||0]]){const card=document.createElement('article');card.append(line(label,value));grid.append(card);}area.append(grid);
 area.append(line('الفترة',metrics?metrics.windowDays+' يومًا':'—'),line('آخر تحديث',new Intl.DateTimeFormat('ar-AE',{timeZone:'Asia/Dubai',timeStyle:'medium'}).format(Date.now())+' بتوقيت دبي'));
 const outbox=data.consultant?.outbox;if(outbox?.uncertain||outbox?.failed)area.append(line('رسائل تحتاج مراجعة',(outbox.uncertain||0)+(outbox.failed||0)));
 const jobs=await call('handoffs'),container=document.getElementById('jobs');container.replaceChildren();
 for(const h of jobs){const card=document.createElement('article'),heading=document.createElement('h2');heading.textContent='طلب تثبيت — '+(labels[h.state]||h.state);card.append(heading);
 const r=h.summary?.request||{},o=h.summary?.offer||{};
 card.append(line('المرجع',h.id),line('العميل',h.customer),line('المسار',(r.origin||'—')+' ← '+(r.destination||'—')),line('الذهاب',r.departureDate),line('العودة',r.returnDate),line('الشركة',o.provider==='flycham'?'فلاي شام':o.provider==='airarabia'?'العربية للطيران':'—'),line('رقم الرحلة',o.timing?.out?.flight),line('السعر المعروض',o.price?.sellingTotal?o.price.sellingTotal+' درهم':'يحتاج تحقق'));
 if(h.state!=='issued')for(const [action,label]of [['claim','استلام المحادثة وإيقاف الرد الآلي'],['release','إعادة المحادثة للمساعد']]){const b=document.createElement('button');b.textContent=label;b.onclick=async()=>{try{await call('handoffs/'+h.id+'/'+action,'POST');await load();}catch(e){error.textContent=e.message;}};card.append(b);}
 if(h.state==='claimed'){const b=document.createElement('button');b.textContent='تسجيل إصدار تم فعليًا';b.onclick=async()=>{if(!confirm('هل صدرت التذكرة بالفعل؟ هذا يسجّل النتيجة فقط ولا يُصدر تذكرة.'))return;try{await call('handoffs/'+h.id+'/issued','POST',{ticketConfirmed:true});await load();}catch(e){error.textContent=e.message;}};card.append(b);}container.append(card);
 }
 }catch(e){error.textContent=e.message;}finally{busy=false;}}
document.getElementById('load').onclick=()=>{clearInterval(refresh);load();refresh=setInterval(()=>{if(field.value&&!document.hidden)load();},15000);};
window.addEventListener('pagehide',()=>clearInterval(refresh));
