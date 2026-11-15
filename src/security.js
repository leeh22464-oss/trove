// 安全：SSRF 防护、Origin/CSRF 校验、上传类型白名单。
import dns from 'node:dns/promises';
import net from 'node:net';

const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^192\.0\.0\./, /^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./,
  /^224\./, /^240\./, /^255\./,
];
const PRIVATE_V6 = [/^::1?$/, /^f[cd]/i, /^fe[89ab]/i, /^2001:0?db8:/i];

function v6Bytes(ip) {
  let [head, tail = ''] = ip.split('::');
  const toWords = (s) => s ? s.split(':').flatMap(p => {
    if (p.includes('.')) { const o = p.split('.').map(Number); return [o[0] << 8 | o[1], o[2] << 8 | o[3]]; }
    return [parseInt(p, 16)];
  }) : [];
  const h = toWords(head), t = toWords(tail);
  return [...h, ...(ip.includes('::') ? Array(8 - h.length - t.length).fill(0) : []), ...t];
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return PRIVATE_V4.some(re => re.test(ip));
  if (!net.isIPv6(ip)) return true;
  const w = v6Bytes(ip);
  const embedded = `${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`;
  const first5Zero = w.slice(0, 5).every(x => x === 0);
  if (first5Zero && (w[5] === 0xffff || w[5] === 0)) return w.slice(0, 7).every(x => x === 0) && w[7] <= 1 ? true : isPrivateIp(embedded);
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every(x => x === 0)) return isPrivateIp(embedded);
  if (w[0] === 0x2002) return isPrivateIp(`${w[1] >> 8}.${w[1] & 255}.${w[2] >> 8}.${w[2] & 255}`);
  return PRIVATE_V6.some(re => re.test(ip));
}

const badRequest = (msg) => Object.assign(new Error(msg), { statusCode: 400 });

export async function assertPublicUrl(url, { lookup = dns.lookup } = {}) {
  let u;
  try { u = new URL(url); } catch { throw badRequest('URL 格式不正确'); }
  if (!/^https?:$/.test(u.protocol)) throw badRequest('只允许 http/https 链接');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw badRequest('不允许访问内网地址');
    return u;
  }
  const records = await lookup(host, { all: true });
  for (const r of records) {
    if (isPrivateIp(r.address)) throw badRequest('域名解析到内网地址，已拦截');
  }
  return u;
}

// 抓取 URL：重定向限次、大小限制、超时、SSRF 防护
export async function fetchPage(url, { maxRedirects = 5, maxBytes = 5 * 1024 * 1024, timeoutMs = 20000, fetchImpl = fetch, lookup, accept = 'text/html,application/xhtml+xml,*/*;q=0.8' } = {}) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicUrl(current, { lookup });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'CatchBot/0.1 (+local prompt collector)', 'Accept': accept },
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('重定向缺少 Location');
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`抓取失败：HTTP ${res.status}`), { status: res.status });
      const reader = res.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) throw new Error('页面过大（>5MB），已截断');
        chunks.push(value);
      }
      const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
      return { url: current, buffer: buf, contentType: res.headers.get('content-type') || '' };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('重定向次数过多');
}

export function originAllowed(origin, hostHeader) {
  if (!origin) return true; // 非浏览器客户端
  try {
    const o = new URL(origin);
    if (o.protocol === 'chrome-extension:' || o.protocol === 'moz-extension:') return true;
    const host = (hostHeader || '').split(':')[0];
    if (o.hostname === host || ['127.0.0.1', 'localhost', '::1'].includes(o.hostname)) return true;
    return false;
  } catch { return false; }
}

export const IMAGE_MIMES = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
