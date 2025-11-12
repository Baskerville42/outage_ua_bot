import { OUTAGE_IMAGES_BASE } from '../config/constants.mjs';

export function isValidOutageImageUrl(url) {
  if (typeof url !== 'string') return false;
  if (!url.startsWith(OUTAGE_IMAGES_BASE)) return false;
  if (!url.toLowerCase().endsWith('.png')) return false;
  try { new URL(url); } catch { return false; }
  return true;
}

export async function verifyRemotePng(url) {
  try {
    let res = await fetch(url, { method: 'HEAD' });
    if (!res.ok || !res.headers) {
      res = await fetch(url, { method: 'GET' });
    }
    if (!res.ok) return { ok: false, status: res.status };
    const ct = res.headers.get('content-type') || '';
    if (!ct.toLowerCase().includes('image/png')) {
      if (!url.toLowerCase().endsWith('.png')) return { ok: false, reason: 'content-type' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Add cache-busting cb parameter to a URL
export function cacheBustedUrl(url) {
  try {
    const ts = Date.now();
    const u = new URL(url);
    u.searchParams.set('cb', ts.toString());
    return u.toString();
  } catch (e) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}cb=${Date.now()}`;
  }
}
