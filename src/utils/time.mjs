// Time utilities for Europe/Kyiv timestamp formatting
export function getTimestamp() {
  const tz = 'Europe/Kyiv';
  const now = new Date();
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const parts = fmt.formatToParts(now);
    const get = (type) => parts.find(p => p.type === type)?.value || '';
    const yyyy = get('year');
    const mm = get('month');
    const dd = get('day');
    const hh = get('hour');
    const mi = get('minute');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  } catch {
    const s = now.toLocaleString('en-CA', { timeZone: tz, hour12: false });
    const m = s.match(/(\d{4}-\d{2}-\d{2}).(\d{2}):(\d{2})/);
    if (m) return `${m[1]} ${m[2]}:${m[3]}`;
    const pad = (n) => n.toString().padStart(2, '0');
    const yyyy = now.getFullYear();
    const mm = pad(now.getMonth() + 1);
    const dd = pad(now.getDate());
    const hh = pad(now.getHours());
    const mi = pad(now.getMinutes());
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }
}

export function withTimestamp(caption) {
  const ts = getTimestamp();
  return caption ? `${caption}\nОновлено: ${ts}` : `Оновлено: ${ts}`;
}
