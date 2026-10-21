'use strict';

async function sendTextMessage(to, body, env = process.env) {
  const dryRun = String(env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
  if (dryRun) {
    console.log(`[DRY_RUN] Suppressed WhatsApp reply for recipient ending in ${String(to).slice(-4)} (${body.length} characters)`);
    return { dryRun: true };
  }

  const { WHATSAPP_ACCESS_TOKEN: token, WHATSAPP_PHONE_NUMBER_ID: phoneId } = env;
  const version = env.WHATSAPP_GRAPH_API_VERSION || 'v23.0';
  if (!token || !phoneId) throw new Error('WhatsApp Graph API credentials are missing');

  const response = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } })
  });
  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`WhatsApp Graph API returned ${response.status}: ${responseText.slice(0, 500)}`);
  }
  return response.json();
}

module.exports = { sendTextMessage };
