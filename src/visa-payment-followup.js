'use strict';

// A receipt request is a next-step instruction, never proof of payment.
function paymentReceiptFollowup(store, customer, summary) {
 const c=store?.data?.visaCases?.[customer];
 if(!c||summary?.caseId!==c.id||!['ready','needs_confirmation'].includes(summary?.status)||!c.quote||c.quote.requiresReview||!Number.isFinite(c.quote.total)||c.quote.total<=0||c.paymentStatus==='verified'||c.payment?.status==='confirmed'||c.submissionStatus==='submitted')return '';
 const record=store.data.visaFulfilment?.cases?.[customer];
 if(record?.caseId===c.id&&Object.values(record.receipts||{}).some(receipt=>receipt?.caseId===c.id))return '';
 return 'للخطوة التالية: بعد التحويل ابعت إيصال التحويل هون بنفس المحادثة. المحاسب بيطابق وصول المبلغ للحساب، وبعد اعتماده منأكد لك استلام الدفعة ومنكمل الطلب.';
}
module.exports={paymentReceiptFollowup};
