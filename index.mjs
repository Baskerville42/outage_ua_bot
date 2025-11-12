import './src/config/env.mjs';
import { MAP_FILE, API_BASE, OUTAGE_IMAGES_BASE, DEFAULT_CAPTION } from './src/config/constants.mjs';
import { loadMessageMapFromFile, saveMessageMapToFile } from './src/storage/messageMapIO.mjs';
import { withTimestamp } from './src/utils/time.mjs';
import { cacheBustedUrl, isValidOutageImageUrl, verifyRemotePng } from './src/utils/url.mjs';
import { getMe, getUpdates, ackUpdates, pinMessage, deleteMessage, sendTextMessage } from './src/telegram/api.mjs';

// Завантаження мапи chat_id -> { message_id }
let mapWasNormalized = false;
function loadMessageMap() {
  const { map, wasNormalized } = loadMessageMapFromFile(MAP_FILE);
  mapWasNormalized = wasNormalized;
  return map;
}

function saveMessageMap(map) {
  return saveMessageMapToFile(MAP_FILE, map);
}


const messageMap = loadMessageMap();
let mapDirty = mapWasNormalized;

function removeChat(chatId, reason = '') {
  if (messageMap[chatId]) {
    delete messageMap[chatId];
    mapDirty = true;
    console.warn(`Unregistered chat ${chatId}${reason ? ' — ' + reason : ''}. It will be removed from graphenko-chats.json.`);
    return true;
  }
  return false;
}

// --- Telegram helpers for auto-registration via long polling ---

function registerFromUpdates(updates) {
  const newlyRegistered = [];
  for (const u of updates) {
    const mcm = u.my_chat_member;
    if (!mcm) continue;
    const chat = mcm.chat;
    if (!chat) continue;
    // цікавлять канали і супергрупи
    const type = chat.type;
    if (type !== 'channel' && type !== 'supergroup' && type !== 'group') continue;
    const status = mcm.new_chat_member?.status;

    const chatId = String(chat.id);

    // Якщо бота прибрали з каналу/чату — приберемо запис з мапи
    if (['left', 'kicked', 'restricted'].includes(status)) {
      const prev = !!messageMap[chatId];
      if (removeChat(chatId, `bot status: ${status}`) && prev) {
        // ми змінили мапу, позначимо це
        mapDirty = true;
      }
      continue;
    }

    // реєструємо коли бот стає admin/creator/member
    if (!['administrator', 'creator', 'member'].includes(status)) continue;
    const isNew = !messageMap[chatId];
    if (!messageMap[chatId]) {
      messageMap[chatId] = {};
    }
    // ВАЖЛИВО: НЕ задаємо image_url/caption автоматично — лише реєструємо чат
    if (isNew) newlyRegistered.push(chatId);
  }
  if (newlyRegistered.length > 0) {
    mapDirty = true;
    console.log(`Registered ${newlyRegistered.length} chat(s) from getUpdates.`);
  }
  return newlyRegistered;
}


async function sendPhoto(chat) {
  const url = `${API_BASE}/sendPhoto`;
  const caption = withTimestamp(chat.caption);
  const photoUrl = cacheBustedUrl(chat.image_url);
  const body = {
    chat_id: chat.chat_id,
    photo: photoUrl,
    caption
  };
  if (chat.message_thread_id !== undefined) {
    body.message_thread_id = chat.message_thread_id;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!json.ok) {
      // Якщо бота прибрали з каналу — приберемо запис і не вважатимемо це збоєм
      if (json.error_code === 403 && typeof json.description === 'string' && json.description.toLowerCase().includes('not a member')) {
        removeChat(String(chat.chat_id), '403 Forbidden: not a member');
        return { ok: true, chat, reason: 'unregistered' };
      }
      // Форум-тред закрито (Bad Request: TOPIC_CLOSED) — вважаємо некритичною ситуацією: пропускаємо чат
      if (json.error_code === 400 && typeof json.description === 'string' && json.description.includes('TOPIC_CLOSED')) {
        console.warn(`SKIP sendPhoto for ${chat.chat_id}: ${json.description}`);
        return { ok: true, chat, reason: 'topic-closed' };
      }
      console.error(`sendPhoto ERROR for ${chat.chat_id}:`, JSON.stringify(json));
      return { ok: false, chat, json };
    }
    const messageId = json.result && json.result.message_id;
    console.log(`SENT new message for chat_id=${chat.chat_id} -> message_id=${messageId}`);
    await pinMessage(chat.chat_id, messageId);
    return { ok: true, chat, message_id: messageId, result: json.result };
  } catch (err) {
    console.error(`Network error sendPhoto for ${chat.chat_id}:`, err.message);
    return { ok: false, chat, err };
  }
}

async function editPhoto(chat, messageId) {
  const url = `${API_BASE}/editMessageMedia`;
  const caption = withTimestamp(chat.caption);
  const photoUrl = cacheBustedUrl(chat.image_url);
  const payload = {
    chat_id: chat.chat_id,
    message_id: Number(messageId),
    media: {
      type: 'photo',
      media: photoUrl,
      caption
    }
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (!json.ok) {
      // Обробка "message is not modified" як не-критичної ситуації
      if (json.error_code === 400 && typeof json.description === 'string' && json.description.includes('message is not modified')) {
        console.log(`NOT_MODIFIED for ${chat.chat_id}/${messageId} — content same, considered OK.`);
        await pinMessage(chat.chat_id, messageId);
        return { ok: true, chat, not_modified: true };
      }
      // Форум-тред закрито — пропускаємо без помилки
      if (json.error_code === 400 && typeof json.description === 'string' && json.description.includes('TOPIC_CLOSED')) {
        console.warn(`SKIP editPhoto for ${chat.chat_id}/${messageId}: ${json.description}`);
        return { ok: true, chat, reason: 'topic-closed' };
      }
      // Якщо 400 — наприклад, повідомлення видалене: створюємо нове
      if (json.error_code === 400) {
        console.warn(`EDIT 400 for ${chat.chat_id}/${messageId}: ${json.description}. Will send new message.`);
        const sent = await sendPhoto(chat);
        return { ...sent, replaced: true };
      }
      // Якщо бота прибрали з каналу — приберемо запис і не вважатимемо це збоєм
      if (json.error_code === 403 && typeof json.description === 'string' && json.description.toLowerCase().includes('not a member')) {
        removeChat(String(chat.chat_id), '403 Forbidden: not a member');
        return { ok: true, chat, reason: 'unregistered' };
      }
      console.error(`editMessageMedia ERROR for ${chat.chat_id}/${messageId}:`, JSON.stringify(json));
      return { ok: false, chat, json };
    }
    console.log(`EDITED chat_id=${chat.chat_id} message_id=${messageId} OK`);
    await pinMessage(chat.chat_id, messageId);
    return { ok: true, chat, result: json.result };
  } catch (err) {
    console.error(`Network error editMessageMedia for ${chat.chat_id}/${messageId}:`, err.message);
    return { ok: false, chat, err };
  }
}


async function sendWelcomeMessage(chat_id) {
  const text = '🤖 GraphenkoBot був успішно підключений. Готовий до подальших команд.';
  const r = await sendTextMessage(chat_id, text);
  if (r.ok) {
    const messageId = r.result && r.result.message_id;
    if (!messageMap[chat_id]) messageMap[chat_id] = {};
    if (messageMap[chat_id].welcome_message_id !== messageId) {
      messageMap[chat_id].welcome_message_id = messageId;
      mapDirty = true;
    }
    console.log(`WELCOME sent to chat_id=${chat_id} -> message_id=${messageId}`);
  }
  return r;
}

async function processCommandUpdates(updates) {
  const handled = [];
  if (!Array.isArray(updates)) return handled;
  for (const u of updates) {
    const msg = u.message || u.channel_post;
    if (!msg) continue;
    const chat = msg.chat;
    if (!chat) continue;
    const chatId = String(chat.id);
    const text = msg.text || msg.caption || '';
    if (!text) continue;

    // 1) Handle: /graphenko_caption <caption text> or /graphenko_caption -default
    let capMatch = text.match(/^\s*\/graphenko_caption(?:@\w+)?\s+([\s\S]+)$/i);
    if (capMatch) {
      const raw = capMatch[1];
      const arg = raw.trim();
      if (!messageMap[chatId]) messageMap[chatId] = {};
      if (arg.toLowerCase() === '-default') {
        // Revert to default caption by removing custom one
        if (messageMap[chatId].caption !== undefined) {
          delete messageMap[chatId].caption;
          mapDirty = true;
        }
        await sendTextMessage(chatId, '✅ Підпис скинуто до стандартного. Буде застосовано під час наступного оновлення.');
        // Best-effort: delete the original command message on success
        if (msg.message_id) {
          await deleteMessage(chatId, msg.message_id);
        }
        handled.push(chatId);
        continue;
      }
      if (!arg) {
        await sendTextMessage(chatId, '❌ Порожній підпис. Спробуйте так: /graphenko_caption Мій власний підпис');
        handled.push(chatId);
        continue;
      }
      // Save custom caption
      messageMap[chatId].caption = arg;
      mapDirty = true;
      await sendTextMessage(chatId, '✅ Підпис збережено. Буде застосовано під час наступного оновлення.');
      // Best-effort: delete the original command message on success
      if (msg.message_id) {
        await deleteMessage(chatId, msg.message_id);
      }
      handled.push(chatId);
      continue;
    }

    // 2) Handle: "/graphenko_image <url>" possibly with bot mention
    const m = text.match(/^\s*\/graphenko_image(?:@\w+)?\s+(\S+)\s*$/i);
    if (!m) continue;
    const url = m[1];
    console.log(`CMD /graphenko_image detected for chat_id=${chatId} url=${url}`);
    // Basic validation
    if (!isValidOutageImageUrl(url)) {
      await sendTextMessage(chatId, '❌ Невірний URL. Використовуйте PNG з базою:\n' + OUTAGE_IMAGES_BASE + '\nприклад: /graphenko_image ' + OUTAGE_IMAGES_BASE + 'kyiv/gpv-3-2-emergency.png');
      handled.push(chatId);
      continue;
    }
    // Verify remote resource
    const ver = await verifyRemotePng(url);
    if (!ver.ok) {
      await sendTextMessage(chatId, '❌ Неможливо отримати зображення або воно не PNG. Перевірте URL.');
      handled.push(chatId);
      continue;
    }
    // Save config for chat
    if (!messageMap[chatId]) messageMap[chatId] = {};
    messageMap[chatId].image_url = url;
    // Optional: default caption remains unchanged unless already set
    mapDirty = true;
    // Delete welcome message if exists
    const wid = messageMap[chatId].welcome_message_id;
    if (wid) {
      const del = await deleteMessage(chatId, wid);
      if (del.ok) {
        delete messageMap[chatId].welcome_message_id;
        mapDirty = true;
      }
    }
    // Confirm to user
    await sendTextMessage(chatId, '✅ Зображення збережено. Розсилка увімкнена.');
    // Best-effort: delete the original command message on success
    if (msg.message_id) {
      await deleteMessage(chatId, msg.message_id);
    }
    handled.push(chatId);
  }
  return handled;
}

function updateStoredChatFields(chatId, effective) {
  if (!messageMap[chatId]) messageMap[chatId] = {};
  let touched = false;
  if (effective.image_url && messageMap[chatId].image_url !== effective.image_url) { messageMap[chatId].image_url = effective.image_url; touched = true; }
  if (effective.caption && messageMap[chatId].caption !== effective.caption) { messageMap[chatId].caption = effective.caption; touched = true; }
  if (touched) mapDirty = true;
}

// Entry point
(async () => {
  const results = [];

  // 1) Отримуємо оновлення і реєструємо нові канали (бот доданий у канал)
  const me = await getMe();
  if (me) console.log(`Bot username: @${me.username}`);
  const { updates, lastUpdateId } = await getUpdates();
  let newlyRegistered = [];
  if (updates?.length) {
    newlyRegistered = registerFromUpdates(updates);
  } else {
    const cfgCount = Object.keys(messageMap || {}).length;
    console.log('No updates from Telegram API; proceeding to process configured chats' + (cfgCount ? ` (${cfgCount})` : '.'));
  }

  // Обробляємо текстові команди (наприклад, /graphenko_image <url>) перед головним циклом
  if (updates?.length) {
    await processCommandUpdates(updates);
  }

  const setMessageId = (chatId, messageId) => {
    if (!messageId) return;
    if (!messageMap[chatId]) messageMap[chatId] = {};
    if (messageMap[chatId].message_id !== messageId) {
      messageMap[chatId].message_id = messageId;
      mapDirty = true;
    }
  };

  // Надсилаємо вітальне повідомлення новим чатам і не надсилаємо зображення одразу
  if (newlyRegistered.length > 0) {
    for (const chatId of newlyRegistered) {
      await sendWelcomeMessage(chatId);
      await new Promise(r => setTimeout(r, 400));
    }
  }

  // 2) Обробляємо лише ті чати, що вже є у graphenko-chats.json
  const allIds = Object.keys(messageMap);

  for (const chatId of allIds) {
    const mapCfg = messageMap[chatId] || {};

    const effective = {
      chat_id: chatId,
      image_url: mapCfg.image_url,
      message_thread_id: mapCfg.message_thread_id,
      // Use custom caption if provided, otherwise fall back to default
      caption: mapCfg.caption !== undefined ? mapCfg.caption : DEFAULT_CAPTION
    };

    if (!effective.chat_id) {
      // не повинно статись, але перевіримо
      console.error('SKIP: немає chat_id в ефективній конфігурації.', effective);
      results.push({ ok: false, chat: effective, reason: 'invalid-config' });
      continue;
    }

    if (!effective.image_url) {
      console.warn(`SKIP send/edit for ${effective.chat_id}: не задано image_url.`);
      results.push({ ok: true, chat: effective, reason: 'no-image' });
      continue;
    }

    const known = messageMap[chatId]?.message_id;

    if (!known) {
      const r = await sendPhoto(effective);
      // If chat was unregistered during send (e.g., 403 not a member), do not touch the map further
      if (r && r.ok && r.reason === 'unregistered') { results.push(r); continue; }
      if (r.ok && r.message_id) setMessageId(chatId, r.message_id);
      // Зберігаємо image_url/caption до мапи
      updateStoredChatFields(chatId, effective);
      results.push(r);
    } else {
      const r = await editPhoto(effective, known);
      // If chat was unregistered during edit (e.g., 403 not a member), do not touch the map further
      if (r && r.ok && r.reason === 'unregistered') { results.push(r); continue; }
      if (r.ok && r.replaced && r.message_id) {
        setMessageId(chatId, r.message_id);
      }
      // оновимо збережені image_url/caption, якщо змінилися
      updateStoredChatFields(chatId, effective);
      results.push(r);
    }

    // невелика пауза, щоб не спамити API
    await new Promise(r => setTimeout(r, 600));
  }

  // 3) Зберігаємо мапу, якщо змінилась
  if (mapDirty) {
    const ok = saveMessageMap(messageMap);
    if (ok) {
      console.log('Message map saved to graphenko-chats.json.');
    }
  } else {
    console.log('Message map unchanged.');
  }

  // 4) Позначаємо оновлення як прочитані (щоб не реєструвати двічі)
  if (lastUpdateId !== null && lastUpdateId !== undefined) {
    await ackUpdates(lastUpdateId);
  }

  // Підсумкова статистика виконання
  const sentNew = results.filter(r => r && r.ok && r.message_id && !r.replaced).length;
  const replacedNew = results.filter(r => r && r.ok && r.replaced && r.message_id).length;
  const edited = results.filter(r => r && r.ok && r.result && !r.not_modified).length;
  const notModified = results.filter(r => r && r.ok && r.not_modified).length;
  const skippedNoImage = results.filter(r => r && r.reason === 'no-image').length;
  const unregistered = results.filter(r => r && r.ok && r.reason === 'unregistered').length;
  const invalidConfig = results.filter(r => r && r.reason === 'invalid-config').length;
  const topicClosed = results.filter(r => r && r.ok && r.reason === 'topic-closed').length;

  console.log(`Summary: total=${results.length}, sent_new=${sentNew}, replaced=${replacedNew}, edited=${edited}, not_modified=${notModified}, skipped_no_image=${skippedNoImage}, unregistered=${unregistered}, invalid_config=${invalidConfig}, topic_closed=${topicClosed}`);

  // Фільтруємо реальні помилки (ок=false і не "invalid-config")
  const failures = results.filter(r => !r.ok && r.reason !== 'invalid-config');
  if (failures.length) {
    console.error(`Completed with ${failures.length} failures out of ${results.length}.`);
    process.exit(10);
  } else {
    console.log('All chats processed (sent/edited/not-modified/skipped/unregistered).');
  }
})();
