import { API_BASE } from '../config/constants.mjs';

export async function getMe() {
  try {
    const res = await fetch(`${API_BASE}/getMe`);
    const json = await res.json();
    if (!json.ok) {
      console.error('getMe ERROR:', JSON.stringify(json));
      return null;
    }
    return json.result;
  } catch (e) {
    console.error('Network error getMe:', e.message);
    return null;
  }
}

export async function getUpdates(offset) {
  const body = {
    timeout: 0,
    allowed_updates: ['my_chat_member', 'message', 'channel_post']
  };
  if (offset) body.offset = offset;
  try {
    const res = await fetch(`${API_BASE}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!json.ok) {
      console.error('getUpdates ERROR:', JSON.stringify(json));
      return { updates: [], lastUpdateId: null };
    }
    let last = null;
    for (const u of json.result) last = u.update_id;
    return { updates: json.result || [], lastUpdateId: last };
  } catch (e) {
    console.error('Network error getUpdates:', e.message);
    return { updates: [], lastUpdateId: null };
  }
}

export async function ackUpdates(lastUpdateId) {
  if (!lastUpdateId && lastUpdateId !== 0) return;
  await getUpdates(lastUpdateId + 1);
}

export async function pinMessage(chat_id, message_id) {
  const url = `${API_BASE}/pinChatMessage`;
  try {
    const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ chat_id, message_id, disable_notification:true }) });
    const json = await res.json();
    if (!json.ok) { console.error(`pinChatMessage ERROR for ${chat_id}/${message_id}:`, JSON.stringify(json)); return { ok: false }; }
    console.log(`PINNED chat_id=${chat_id} message_id=${message_id} OK`);
    return { ok: true };
  } catch (err) {
    console.error(`Network error pinChatMessage for ${chat_id}/${message_id}:`, err.message);
    return { ok: false };
  }
}

export async function deleteMessage(chat_id, message_id) {
  const url = `${API_BASE}/deleteMessage`;
  try {
    const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ chat_id, message_id }) });
    const json = await res.json();
    if (!json.ok) { console.error(`deleteMessage ERROR for ${chat_id}/${message_id}:`, JSON.stringify(json)); return { ok: false }; }
    console.log(`DELETED chat_id=${chat_id} message_id=${message_id} OK`);
    return { ok: true };
  } catch (err) {
    console.error(`Network error deleteMessage for ${chat_id}/${message_id}:`, err.message);
    return { ok: false };
  }
}

export async function sendTextMessage(chat_id, text) {
  const url = `${API_BASE}/sendMessage`;
  const body = { chat_id, text };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!json.ok) {
      console.error(`sendMessage ERROR for ${chat_id}:`, JSON.stringify(json));
      return { ok: false, json };
    }
    return { ok: true, result: json.result };
  } catch (err) {
    console.error(`Network error sendMessage for ${chat_id}:`, err.message);
    return { ok: false, err };
  }
}
