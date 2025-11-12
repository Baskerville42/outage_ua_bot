import path from 'node:path';

export const REPO_ROOT = process.cwd();
export const MAP_FILE = path.join(REPO_ROOT, 'graphenko-chats.json');

export const token = process.env.BOT_TOKEN;
export const API_BASE = token ? `https://api.telegram.org/bot${token}` : '';

export const OUTAGE_IMAGES_BASE = 'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/refs/heads/main/images/';
export const DEFAULT_CAPTION = '⚡️ Графік стабілізаційних вимкнень. Це повідомлення оновлюється щогодини автоматично.';
