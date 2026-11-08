'use strict';
const {normalize}=require('./saudi-visa-policy');

// This is a conversation label, never authorization to pay, submit, cancel,
// open a case, change facts or confirm an operational step. The caller must
// keep its existing evidence-bound confirmation and pending-question rules.
const ACK_AR=/^(?:(?:نعم|اي|ايي|ايوه|ايوا|اه|اها|اجل|تمام|ماشي|زين|حاضر|اوكي|اوك|اوكيه|فهمت|واضح|صح|مزبوط|مظبوط|صحيح|اكيد)(?:\s+|$)){1,3}$/u;
const ACK_EN=/^(?:yes|yeah|yep|yup|ok|okay|alright|all right|sure|understood|got it|i see|correct|right)(?:\s+(?:ok|okay|thanks))?$/u;
const ACK_FR=/^(?:oui|ouais|ok|okay|d['’]accord|entendu|compris|bien compris|je comprends|c['’]est clair|c['’]est bon|exact|tout a fait)$/u;
const THANKS=/^(?:(?:تمام|اوكي|طيب|ماشي|ok|okay|yes|oui)\s+)?(?:شكرا|شكرا الك|شكرا لك|شكرا جزيلا|الف شكر|يسلمو|تسلم|تسلمي|مشكور|مشكوره|يعطيك العافيه|الله يعافيك|جزاك الله خير|thanks|thank you|thank you very much|many thanks|thanks a lot|merci|merci beaucoup|je vous remercie)$/u;
const NEGATIVE=/^(?:لا|لا لا|لاء|كلا|لا ابدا|لا شكرا|مو هيك|مش هيك|مش كده|مش كدا|مو صح|مش صح|مش صحيح|غير صحيح|مو هاد|مش هاد|مو هيدا|مش ده|no|nope|nah|not really|not quite|no thanks|no thank you|that['’]s not right|non|non merci|pas vraiment|pas tout a fait|ce n['’]est pas ca)$/u;
const WHY_AR=/^(?:(?:طيب|طب|تمام|اوكي|اوك|اي|نعم|لا|بس)\s+){0,2}(?:وليش|ليش|ليه|ليش لا|ليه لا|لشو|لايش|ليش هيك|ليه كده|ليه كدا|ليش كذا|شو السبب|وش السبب|ايش السبب|اش السبب|ايه السبب|شو الداعي|عشان ايه|مشان شو|على اي اساس|ليش السؤال|ليه السؤال|ليش هالسوال|ليش هالطلب|ليش عم تسال|ليش بتسال|ليه بتسال|ليش تسالني|ليه بتسالني|ليه السؤال ده)$/u;
const WHY_EN=/^(?:(?:okay|ok|yes|no|but|thanks)\s+){0,2}(?:why|why not|why is that|why do you ask|why are you asking|what for)$/u;
const WHY_FR=/^(?:(?:oui|non|ok|d['’]accord|mais|merci)\s+){0,2}(?:pourquoi|pourquoi pas|pour quelle raison|pourquoi cette question|pourquoi vous demandez|pourquoi demandez[- ]vous|pourquoi me demandez[- ]vous cela)$/u;
const MEANING_AR=/^(?:(?:طيب|طب|تمام|بس)\s+)?(?:يعني|يعني شو|يعني ايه|يعني شنو|كيف يعني|شو يعني|شو قصدك|شو بتقصد|وش تقصد|ايش تقصد|اش تقصد|قصدك ايه|ما فهمت|مافهمت|ما فهمتش|مافهمتش|مفهمتش|مش فاهم|مو فاهم|مب فاهم|ماني فاهم|ما فهمنا|مش واضح|مو واضح|مب واضح|وضحلي|وضح لي|اشرحلي|اشرح لي|فسرلي|فسر لي|شو|ها)$/u;
const MEANING_EN=/^(?:what|huh|pardon|sorry|what do you mean|i don['’]?t understand|i do not understand|i don['’]?t get it|i do not get it|please explain|can you explain|please clarify|can you clarify|could you repeat that)$/u;
const MEANING_FR=/^(?:quoi|pardon|comment|je ne comprends pas|je n['’]ai pas compris|que voulez[- ]vous dire|qu['’]est[- ]ce que ca veut dire|pouvez[- ]vous expliquer|expliquez[- ]moi|pouvez[- ]vous repeter)$/u;
const PAUSE_AR=/^(?:(?:لا|طيب|تمام|اوكي)\s+)?(?:بعدين|بعد شوي|لاحقا|مو هلق|مو هلا|مو هلء|مش دلوقتي|مو الحين|مب الحين|مو حاليا|ليس الان|مش الان|ما بدي هلق|مش عايز دلوقتي|خليني افكر|خلني افكر|خليني فكر|بفكر|هفكر|هافكر|بدي فكر|بدي افكر|بدي وقت|برجعلك بعدين|ارجعلك بعدين|بحكي معك بعدين|خلينا بعدين|استني شوي|استناني شوي|دقيقه|لحظه|لحظه بس|شوي)$/u;
const PAUSE_EN=/^(?:(?:no|ok|okay)\s+)?(?:not now|later|maybe later|let me think|i['’]ll think about it|i will think about it|i need time|give me a moment|one moment|a moment|wait a moment|hold on|just a moment|i['’]ll come back later)$/u;
const PAUSE_FR=/^(?:(?:non|ok|d['’]accord)\s+)?(?:pas maintenant|plus tard|peut[- ]etre plus tard|je vais reflechir|laissez[- ]moi reflechir|un instant|un moment|attendez un peu|je reviens plus tard)$/u;
const ACK_EMOJI=/^(?:(?:👍|👌|🙏)[\u{1F3FB}-\u{1F3FF}]?|✅){1,3}$/u;
const DECORATION=/[👍👌🙏🌷✅\u{1F3FB}-\u{1F3FF}\uFE0F]/gu;
const result=(kind,clarification=null)=>({kind,clarification});

function classifyVisaShortReply(text){
 if(typeof text!=='string'||!text.trim()||text.length>180||/\p{N}/u.test(text))return null;
 const raw=text.trim();
 // Quoted/forwarded words are not the customer's own acknowledgement.
 if(/^["'«“].*["'»”]$/su.test(raw))return null;
 const questioned=/[؟?]/u.test(raw);
 let n=normalize(raw).normalize('NFD').replace(/[\u0300-\u036f\u0640]/g,'')
  .replace(/[.!?,،؛;…؟]+/gu,' ').replace(/\s+/g,' ').trim();
 if(ACK_EMOJI.test(n.replace(/\s|\uFE0F/gu,'')))return questioned?result('clarify','meaning'):result('acknowledgement');
 // Only familiar decorative emoji may accompany an otherwise complete phrase.
 n=n.replace(DECORATION,'').replace(/\s+/g,' ').trim();
 if(!n)return null;
 if(WHY_AR.test(n)||WHY_EN.test(n)||WHY_FR.test(n))return result('clarify','why');
 if(MEANING_AR.test(n)||MEANING_EN.test(n)||MEANING_FR.test(n))return result('clarify','meaning');
 if(PAUSE_AR.test(n)||PAUSE_EN.test(n)||PAUSE_FR.test(n))return questioned?result('clarify','meaning'):result('pause');
 if(NEGATIVE.test(n))return questioned?result('clarify','meaning'):result('negative');
 if(THANKS.test(n))return questioned?result('clarify','meaning'):result('thanks');
 if(ACK_AR.test(n)||ACK_EN.test(n)||ACK_FR.test(n))return questioned?result('clarify','meaning'):result('acknowledgement');
 return null;
}
module.exports={classifyVisaShortReply};
