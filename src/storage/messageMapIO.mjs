import fs from 'node:fs';

// Load message map from a file. Returns { map, wasNormalized }
export function loadMessageMapFromFile(filePath) {
  let mapWasNormalized = false;
  try {
    if (!fs.existsSync(filePath)) return { map: {}, wasNormalized: false };
    const txt = fs.readFileSync(filePath, 'utf8').trim();
    if (!txt) return { map: {}, wasNormalized: false };
    const arr = JSON.parse(txt);
    if (!Array.isArray(arr)) return { map: {}, wasNormalized: false };
    const map = {};

    for (const item of arr) {
      if (!item || typeof item !== 'object') { mapWasNormalized = true; continue; }

      const keys = Object.keys(item);

      // Case A: canonical format { "<chat_id>": { ...fields... } }
      if (keys.length === 1 && !('chat_id' in item)) {
        const k = keys[0];
        const val = item[k];
        const chatId = String(k);
        if (val && typeof val === 'object') {
          if (val.deleted === true) { mapWasNormalized = true; continue; }
          const entry = {};
          if (val.message_id !== undefined) entry.message_id = val.message_id;
          if (val.message_ids !== undefined) entry.message_ids = val.message_ids;
          if (val.image_url) entry.image_url = val.image_url;
          if (Object.prototype.hasOwnProperty.call(val, 'caption')) entry.caption = val.caption;
          if (val.welcome_message_id !== undefined) entry.welcome_message_id = val.welcome_message_id;
          if (val.message_thread_id !== undefined) entry.message_thread_id = val.message_thread_id;
          map[chatId] = entry;
        } else {
          mapWasNormalized = true; // malformed value
        }
        continue;
      }

      // Case B: flat format { chat_id: "...", message_id?, image_url?, caption?, welcome_message_id?, deleted? }
      if ('chat_id' in item) {
        const chatId = String(item.chat_id);
        if (!chatId) { mapWasNormalized = true; continue; }
        if (item.deleted === true) { mapWasNormalized = true; continue; }
        const entry = {};
        if (item.message_id !== undefined) entry.message_id = item.message_id;
        if (item.message_ids !== undefined) entry.message_ids = item.message_ids;
        if (item.image_url) entry.image_url = item.image_url;
        if (Object.prototype.hasOwnProperty.call(item, 'caption')) entry.caption = item.caption;
        if (item.welcome_message_id !== undefined) entry.welcome_message_id = item.welcome_message_id;
        if (item.message_thread_id !== undefined) entry.message_thread_id = item.message_thread_id;
        map[chatId] = entry;
        mapWasNormalized = true; // we will rewrite to canonical
        continue;
      }

      // Unknown shape — ignore safely
      mapWasNormalized = true;
    }

    return { map, wasNormalized: mapWasNormalized };
  } catch (e) {
    console.error('WARN: Не вдалося прочитати graphenko-chats.json, починаємо з порожньої мапи:', e.message);
    return { map: {}, wasNormalized: false };
  }
}

// Save message map back to file (canonical format)
export function saveMessageMapToFile(filePath, map) {
  try {
    const keys = Object.keys(map).sort((a, b) => a.localeCompare(b));
    const arr = keys.map(k => {
      const entry = {};
      if (map[k] && typeof map[k] === 'object') {
        if (map[k].message_id !== undefined) entry.message_id = map[k].message_id;
        if (map[k].message_ids !== undefined) entry.message_ids = map[k].message_ids;
        if (map[k].image_url) entry.image_url = map[k].image_url;
        if (Object.prototype.hasOwnProperty.call(map[k], 'caption')) entry.caption = map[k].caption;
        if (map[k].welcome_message_id !== undefined) entry.welcome_message_id = map[k].welcome_message_id;
        if (map[k].message_thread_id !== undefined) entry.message_thread_id = map[k].message_thread_id;
      }
      return { [k]: entry };
    });
    const json = JSON.stringify(arr, null, 2) + '\n';
    fs.writeFileSync(filePath, json, 'utf8');
    return true;
  } catch (e) {
    console.error('ERROR: Не вдалося записати graphenko-chats.json:', e.message);
    return false;
  }
}
