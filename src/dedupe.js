// 去重：URL 规范化、内容 hash、simhash 近似重复。
import { createHash } from 'node:crypto';
import { stripTrackingParams } from './clean.js';

export function normalizeUrl(url) {
  if (!url) return '';
  let u;
  try { u = new URL(String(url).trim()); } catch { return String(url).trim().toLowerCase(); }
  u = new URL(stripTrackingParams(u.toString()));
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  if (u.hostname === 'twitter.com') u.hostname = 'x.com';
  let p = u.pathname.replace(/\/+$/, '') || '';
  u.pathname = p;
  u.hash = '';
  const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  u.search = new URLSearchParams(params).toString();
  let s = u.toString().replace(/\/$/, '');
  if (u.searchParams.toString() === '') s = s.replace(/\?$/, '');
  return s;
}

export function contentHash(text) {
  return createHash('sha256').update(String(text || '').trim()).digest('hex');
}

function shingles(text, n = 4) {
  const s = String(text || '').replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i + n <= s.length; i++) set.add(s.slice(i, i + n));
  return set;
}

export function simhash(text) {
  const v = new Array(64).fill(0);
  for (const sh of shingles(text)) {
    const h = createHash('sha256').update(sh).digest();
    for (let i = 0; i < 64; i++) {
      const bit = (h[i >> 3] >> (7 - (i & 7))) & 1;
      v[i] += bit ? 1 : -1;
    }
  }
  const out = Buffer.alloc(8);
  for (let i = 0; i < 64; i++) if (v[i] > 0) out[i >> 3] |= 1 << (7 - (i & 7));
  return out.toString('hex');
}

export function hamming(aHex, bHex) {
  const a = Buffer.from(aHex, 'hex'), b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i];
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

export function jaccard(textA, textB) {
  const a = shingles(textA), b = shingles(textB);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function findDuplicates(db, { contentHash: hash, simhash: sim, url, excludeId = 0 }) {
  const exact = [];
  const near = [];
  if (hash) {
    for (const r of db.prepare("SELECT id,title FROM items WHERE content_hash=? AND id!=? AND status!='trash'").all(hash, excludeId)) {
      exact.push({ ...r, via: 'hash' });
    }
  }
  if (url) {
    const nu = normalizeUrl(url);
    for (const r of db.prepare("SELECT id,title,source_url FROM items WHERE id!=? AND status!='trash' AND source_url!=''").all(excludeId)) {
      if (normalizeUrl(r.source_url) === nu && !exact.find(e => e.id === r.id)) {
        exact.push({ ...r, via: 'url' });
      }
    }
  }
  if (sim) {
    for (const r of db.prepare("SELECT id,title,simhash FROM items WHERE id!=? AND status!='trash' AND simhash!=''").all(excludeId)) {
      const d = hamming(sim, r.simhash);
      if (d <= 6 && !exact.find(e => e.id === r.id)) near.push({ ...r, via: 'simhash', distance: d });
    }
  }
  return { exact, near };
}
