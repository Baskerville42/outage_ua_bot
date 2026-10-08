import './src/config/env.mjs';
import { MAP_FILE, API_BASE, OUTAGE_IMAGES_BASE, DEFAULT_CAPTION } from './src/config/constants.mjs';
import { loadMessageMapFromFile, saveMessageMapToFile } from './src/storage/messageMapIO.mjs';
import { withTimestamp } from './src/utils/time.mjs';
import { cacheBustedUrl, isValidOutageImageUrl, verifyRemotePng } from './src/utils/url.mjs';
import { getMe, getUpdates, ackUpdates, pinMessage, deleteMessage, sendTextMessage, sendMediaGroup } from './src/telegram/api.mjs';

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

function removeChatWithoutAdminRights(chatId, json) {
  if (json?.error_code !== 400 || typeof json.description !== 'string' ||
      !json.description.toLowerCase().includes('need administrator rights in the channel chat')) {
    return false;
  }
  return removeChat(String(chatId), json.description);
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
      if (removeChatWithoutAdminRights(chat.chat_id, json)) {
        return { ok: true, chat, reason: 'unregistered' };
      }
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
      if (removeChatWithoutAdminRights(chat.chat_id, json)) {
        return { ok: true, chat, reason: 'unregistered' };
      }
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
        // Спробуємо видалити старе повідомлення, щоб не засмічувати чат
        await deleteMessage(chat.chat_id, messageId);
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

async function sendAlbum(chat) {
  const images = Array.isArray(chat.image_url) ? chat.image_url : [chat.image_url];
  const caption = withTimestamp(chat.caption);

  const media = images.map((url, index) => {
    return {
      type: 'photo',
      media: cacheBustedUrl(url),
      // caption only for the first item
      caption: index === 0 ? caption : ''
    };
  });

  const res = await sendMediaGroup(chat.chat_id, media, { message_thread_id: chat.message_thread_id });
  if (!res.ok) {
    if (removeChatWithoutAdminRights(chat.chat_id, res.json)) {
      return { ok: true, chat, reason: 'unregistered' };
    }
    // Check for specific errors if needed
    if (res.json && res.json.error_code === 403) {
      removeChat(String(chat.chat_id), '403 Forbidden: not a member');
      return { ok: true, chat, reason: 'unregistered' };
    }
    return { ok: false, chat, json: res.json };
  }

  // result is array of messages
  const messages = res.result;
  const messageIds = messages.map(m => m.message_id);
  console.log(`SENT album for chat_id=${chat.chat_id} -> message_ids=${messageIds.join(',')}`);

  // Pin the first message
  if (messageIds.length > 0) {
    await pinMessage(chat.chat_id, messageIds[0]);
  }

  return { ok: true, chat, message_ids: messageIds, result: res.result };
}

async function editAlbum(chat, existingMessageIds) {
  // Editing media group is tricky. Telegram allows editing media of specific message.
  // But we want to update the whole album. 
  // Simplest robust approach: if we are in "Album Mode", we just edit each message in the album 
  // with the corresponding new image.
  // Assumption: number of images hasn't changed. If it changed, we should have re-sent.

  const images = Array.isArray(chat.image_url) ? chat.image_url : [chat.image_url];
  const caption = withTimestamp(chat.caption);

  if (images.length !== existingMessageIds.length) {
    console.warn(`Mismatch in album size for ${chat.chat_id}: config=${images.length}, stored=${existingMessageIds.length}. Will resend.`);
    return { ok: false, reason: 'size-mismatch' };
  }

  const results = [];
  for (let i = 0; i < images.length; i++) {
    const msgId = existingMessageIds[i];
    const imgUrl = images[i];
    const isFirst = i === 0;

    // We reuse editPhoto logic but need to adapt it or call editMessageMedia directly
    // Let's call editMessageMedia directly here to avoid confusion
    const url = `${API_BASE}/editMessageMedia`;
    const photoUrl = cacheBustedUrl(imgUrl);
    const payload = {
      chat_id: chat.chat_id,
      message_id: Number(msgId),
      media: {
        type: 'photo',
        media: photoUrl,
        caption: isFirst ? caption : ''
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
        if (removeChatWithoutAdminRights(chat.chat_id, json)) {
          return { ok: true, chat, reason: 'unregistered' };
        }
        if (json.error_code === 400 && typeof json.description === 'string' && json.description.includes('message is not modified')) {
          // ok
        } else {
          console.error(`editAlbum error for ${chat.chat_id}/${msgId}:`, json);
          results.push({ ok: false, json });
        }
      } else {
        results.push({ ok: true });
      }
    } catch (e) {
      console.error(`editAlbum network error for ${chat.chat_id}/${msgId}:`, e);
      results.push({ ok: false, err: e });
    }
  }

  // If we are here, we attempted to edit all. 
  // We can consider it success even if some were not modified.
  console.log(`EDITED album for chat_id=${chat.chat_id} (count=${images.length})`);
  // Pin first one just in case
  if (existingMessageIds.length > 0) {
    await pinMessage(chat.chat_id, existingMessageIds[0]);
  }

  return { ok: true, chat, result: results };
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
    // Clear array if switching to single
    if (messageMap[chatId].message_ids) delete messageMap[chatId].message_ids;

    if (messageMap[chatId].message_id !== messageId) {
      messageMap[chatId].message_id = messageId;
      mapDirty = true;
    }
  };

  const setMessageIds = (chatId, messageIds) => {
    if (!messageIds || !Array.isArray(messageIds)) return;
    if (!messageMap[chatId]) messageMap[chatId] = {};
    // Clear single if switching to array
    if (messageMap[chatId].message_id) delete messageMap[chatId].message_id;

    // Check if changed
    const current = messageMap[chatId].message_ids || [];
    if (current.length !== messageIds.length || !current.every((v, i) => v === messageIds[i])) {
      messageMap[chatId].message_ids = messageIds;
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

    const knownSingle = messageMap[chatId]?.message_id;
    const knownAlbum = messageMap[chatId]?.message_ids; // array of IDs

    const isAlbumConfig = Array.isArray(effective.image_url) && effective.image_url.length > 1;

    // STATE MIGRATION / HANDLING

    // Case 1: Config is Album, but we have Single stored -> Delete Single, Send Album
    if (isAlbumConfig && knownSingle) {
      console.log(`Switching ${chatId} from Single to Album. Deleting old message ${knownSingle}...`);
      await deleteMessage(chatId, knownSingle);
      // continue to send new album
    }

    // Case 2: Config is Single, but we have Album stored -> Delete Album, Send Single
    if (!isAlbumConfig && knownAlbum) {
      console.log(`Switching ${chatId} from Album to Single. Deleting old messages ${knownAlbum.join(',')}...`);
      for (const mid of knownAlbum) await deleteMessage(chatId, mid);
      // continue to send new single
    }

    // Case 3: Config is Album, we have Album stored, but size mismatch -> Delete Album, Send Album
    if (isAlbumConfig && knownAlbum && knownAlbum.length !== effective.image_url.length) {
      console.log(`Album size changed for ${chatId}. Deleting old messages...`);
      for (const mid of knownAlbum) await deleteMessage(chatId, mid);
      // continue to send new album
    }

    // Now decide action based on current clean state

    // RELOAD state after potential deletions (we haven't updated map yet, but we know what we deleted)
    // Actually simpler: if we deleted, we just treat it as "not known" for the next step.
    // But we need to be careful not to use the old 'knownSingle' / 'knownAlbum' variables if we just deleted them.

    // Let's refine:
    let mode = 'send'; // or 'edit'
    let currentIds = null; // single ID or array of IDs to edit

    if (isAlbumConfig) {
      if (knownAlbum && knownAlbum.length === effective.image_url.length) {
        mode = 'edit';
        currentIds = knownAlbum;
      } else {
        mode = 'send';
      }
    } else {
      // Single config
      if (knownSingle && !isAlbumConfig) { // ensure we didn't just decide to delete it
        // wait, if we had knownSingle and isAlbumConfig was true, we deleted it.
        // so if isAlbumConfig is false, and we have knownSingle, we edit.
        mode = 'edit';
        currentIds = knownSingle;
      } else {
        mode = 'send';
      }
    }

    // Override mode if we just performed a deletion logic above
    if (isAlbumConfig && knownSingle) mode = 'send';
    if (!isAlbumConfig && knownAlbum) mode = 'send';
    if (isAlbumConfig && knownAlbum && knownAlbum.length !== effective.image_url.length) mode = 'send';

    if (mode === 'send') {
      if (isAlbumConfig) {
        const r = await sendAlbum(effective);
        if (r && r.ok && r.reason === 'unregistered') { results.push(r); continue; }
        if (r.ok && r.message_ids) setMessageIds(chatId, r.message_ids);
        updateStoredChatFields(chatId, effective);
        results.push(r);
      } else {
        const r = await sendPhoto(effective);
        if (r && r.ok && r.reason === 'unregistered') { results.push(r); continue; }
        if (r.ok && r.message_id) setMessageId(chatId, r.message_id);
        updateStoredChatFields(chatId, effective);
        results.push(r);
      }
    } else {
      // Edit
      if (isAlbumConfig) {
        const r = await editAlbum(effective, currentIds);
        if (r && r.ok && r.reason === 'unregistered') { results.push(r); continue; }
        // if edit failed due to size mismatch (should be caught above) or other fatal, we might want to resend?
        // For now, simple edit.
        updateStoredChatFields(chatId, effective);
        results.push(r);
      } else {
        const r = await editPhoto(effective, currentIds);
        if (r && r.ok && r.reason === 'unregistered') { results.push(r); continue; }
        if (r.ok && r.replaced && r.message_id) {
          setMessageId(chatId, r.message_id);
        }
        updateStoredChatFields(chatId, effective);
        results.push(r);
      }
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
