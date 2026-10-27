'use strict';
// For an authenticated staff page only. Does not persist secrets.
function setupRaadDirectLogin(root, getAdminKey) {
 const form=root.querySelector('form'), img=root.querySelector('[data-captcha-image]'), status=root.querySelector('[data-status]'), start=root.querySelector('[data-start]'), stop=root.querySelector('[data-close]');
 let imageUrl=null,busy=false;
 const message=t=>{status.textContent=t;};
 const clearImage=()=>{if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=null;img.removeAttribute('src');};
 async function call(action,body){const headers={Authorization:'Bearer '+getAdminKey()};if(body)headers['Content-Type']='application/json';const r=await fetch('/internal/raad-direct-login/'+action,{method:'POST',credentials:'same-origin',cache:'no-store',headers,body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error('UNAVAILABLE');return r;}
 async function run(fn){if(busy)return;busy=true;try{await fn();}catch{clearImage();message('تعذرت العملية. أعد بدء الجلسة.');}finally{busy=false;}}
 start.addEventListener('click',()=>run(async()=>{clearImage();await call('start');const r=await call('image');imageUrl=URL.createObjectURL(await r.blob());img.src=imageUrl;message('أدخل بيانات الدخول والرمز الظاهر في الصورة.');}));
 form.addEventListener('submit',e=>{e.preventDefault();run(async()=>{const username=form.elements.username.value,password=form.elements.password.value,captcha=form.elements.captcha.value;try{const r=await call('submit',{username,password,captcha});const result=await r.json();message(result.submitted?'تم إرسال محاولة الدخول؛ حالة الدخول لم تُتحقق بعد.':'تعذرت المحاولة.');}finally{form.elements.password.value='';form.elements.captcha.value='';clearImage();}});});
 stop.addEventListener('click',()=>run(async()=>{await call('close');form.reset();clearImage();message('أُغلقت الجلسة.');}));
}
module.exports={setupRaadDirectLogin};
