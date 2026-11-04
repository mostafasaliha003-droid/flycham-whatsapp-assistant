'use strict';

// A receipt request is a next-step instruction, never proof of payment.
function paymentReceiptFollowup(store, customer, summary) {
 const c=store?.data?.visaCases?.[customer];
 if(!c||summary?.caseId!==c.id||!(summary?.status==='ready'||summary?.status==='needs_confirmation'&&summary.customerConfirmationComplete===true)||!c.quote||c.quote.requiresReview||!Number.isFinite(c.quote.total)||c.quote.total<=0||c.paymentStatus==='verified'||c.payment?.status==='confirmed'||c.submissionStatus==='submitted')return '';
 const record=store.data.visaFulfilment?.cases?.[customer];
 if(record?.caseId===c.id&&Object.values(record.receipts||{}).some(receipt=>receipt?.caseId===c.id))return '';
 const total=Number(c.quote.total).toLocaleString('en-US',{maximumFractionDigits:2});
 return `إجمالي الرسوم المعتمدة لملفك ${total} درهم. بعد التحويل ابعت إيصال التحويل هون، ومنأكد لك استلام الدفعة بعد التحقق من وصولها للحساب.`;
}
module.exports={paymentReceiptFollowup};
