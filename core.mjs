// Общий серверный код: хранилище Netlify Blobs, вход, push-уведомления.
// Ничего настраивать не нужно: секретные ключи создаются сами при первом запуске.
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';

export const LOW_STOCK = 5;                 // «заканчивается», если остаток ≤ этого числа
export const TIME_ZONE = 'Asia/Qyzylorda';  // UTC+5, Казахстан

export const money = (n) => Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₸';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let _store;
export const store = () => (_store ||= getStore({ name: 'sklad', consistency: 'strong' }));
export const getJSON = (key) => store().get(key, { type: 'json' });

/**
 * Безопасное изменение записи: прочитать → изменить → записать, только если никто
 * не успел изменить её раньше (по ETag). При конфликте повторяем.
 * fn получает текущие данные (или null) и возвращает новые; undefined — ничего не писать.
 */
export async function update(key, fn) {
  for (let i = 0; i < 8; i++) {
    let cur = await store().getWithMetadata(key, { type: 'json' });
    if (cur && !cur.etag) {
      // ETag не пришёл с данными — берём его отдельно, ДО повторного чтения:
      // если запись изменится между запросами, условие не совпадёт и мы повторим.
      const etag = await etagOf(key);
      const data = await store().get(key, { type: 'json' });
      cur = etag && data != null ? { data, etag } : null;
      if (!cur) continue;
    }
    const next = await fn(cur ? cur.data : null);
    if (next === undefined) return cur ? cur.data : null;
    const res = await store().setJSON(key, next, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (res.modified) return next;
    await new Promise((ok) => setTimeout(ok, 40 + Math.random() * 160));
  }
  throw new HttpError(409, 'Сервер занят, попробуйте ещё раз');
}

async function etagOf(key) {
  const meta = await store().getMetadata(key);
  if (meta?.etag) return meta.etag;
  const { blobs } = await store().list({ prefix: key });
  return blobs.find((b) => b.key === key)?.etag;
}

/* ---------- секреты (создаются автоматически) ---------- */
let _secrets;
export async function secrets() {
  if (_secrets) return _secrets;
  let s = await getJSON('meta:secrets');
  if (!s) {
    const v = webpush.generateVAPIDKeys();
    const fresh = {
      hmac: crypto.randomBytes(32).toString('base64url'),
      vapidPublic: v.publicKey,
      vapidPrivate: v.privateKey,
    };
    const r = await store().setJSON('meta:secrets', fresh, { onlyIfNew: true });
    s = r.modified ? fresh : await getJSON('meta:secrets');
  }
  _secrets = s;
  return s;
}

/* ---------- вход ---------- */
export async function signToken(payload) {
  const { hmac } = await secrets();
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', hmac).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export async function verifyToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const { hmac } = await secrets();
  const good = crypto.createHmac('sha256', hmac).update(body).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
  return { salt, hash: crypto.scryptSync(password, salt, 32).toString('base64url') };
}

export function checkPassword(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 32);
  const want = Buffer.from(hash, 'base64url');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

/* ---------- push ---------- */
export async function notify(uids, title, body, tag = '') {
  const list = [...new Set(uids)];
  if (!list.length) return;
  const { vapidPublic, vapidPrivate } = await secrets();
  const subject = process.env.URL?.startsWith('https://') ? process.env.URL : 'mailto:sklad@example.com';
  webpush.setVapidDetails(subject, vapidPublic, vapidPrivate);
  const payload = JSON.stringify({ title, body, tag });

  await Promise.all(list.map(async (uid) => {
    const subs = (await getJSON(`push:${uid}`)) || [];
    if (!subs.length) return;
    const dead = [];
    await Promise.all(subs.map((s) => webpush
      .sendNotification(s, payload, { TTL: 86400, urgency: 'high' })
      .catch((e) => {
        if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.endpoint);
        else console.warn('push error', e.statusCode, e.body);
      })));
    if (dead.length) {
      await update(`push:${uid}`, (cur) => (cur ? cur.filter((s) => !dead.includes(s.endpoint)) : undefined));
    }
  }));
}
