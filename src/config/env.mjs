// Local .env loader (no external deps). Executes on import.
import fs from 'node:fs';
import path from 'node:path';

(function loadLocalEnv() {
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      let rawLine = lines[i];
      if (!rawLine) continue;
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = rawLine.indexOf('=');
      if (eq === -1) continue;
      const key = rawLine.slice(0, eq).trim();
      let value = rawLine.slice(eq + 1);
      value = value.replace(/^\s+/, '');
      if ((value.startsWith('"') || value.startsWith("'")) && !value.endsWith(value[0])) {
        const q = value[0];
        let acc = value.slice(1);
        while (i + 1 < lines.length) {
          i++;
          const next = lines[i];
          if (next.endsWith(q)) {
            acc += '\n' + next.slice(0, -1);
            value = acc;
            break;
          } else {
            acc += '\n' + next;
          }
        }
      } else {
        const v = value.trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          value = v.slice(1, -1);
        } else {
          value = v;
        }
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (e) {
    console.warn('WARN: Failed to load .env:', e.message);
  }
})();

export {};
