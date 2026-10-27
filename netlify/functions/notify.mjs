// POST /.netlify/functions/notify — приложение продавца сообщает об изменении товара,
// функция рассылает push магазинам (новый товар, поступление, цена) и продавцу (заканчивается).
import { auth, db, notify, money, LOW_STOCK } from '../lib/push.mjs';

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  // Проверяем, что запрос от вошедшего продавца; он может сообщать только о своих товарах
  let sellerId;
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    sellerId = (await auth.verifyIdToken(token)).uid;
  } catch {
    return new Response('unauthorized', { status: 401 });
  }

  const { productId, isNew = false, prevStock = 0, prevPrice = null } = await req.json().catch(() => ({}));
  if (!productId || typeof productId !== 'string') return new Response('productId required', { status: 400 });

  const snap = await db.doc(`sellers/${sellerId}/products/${productId}`).get();
  if (!snap.exists) return Response.json({ ok: false, reason: 'no product' });
  const p = snap.data();

  const sellerName = (await db.doc(`sellers/${sellerId}`).get()).get('name') || 'Продавец';
  const viewers = (await db.collection(`sellers/${sellerId}/viewers`).get()).docs.map((d) => d.id);

  const stock = Number(p.stock || 0);
  const prev = Number(prevStock || 0);
  const tag = `p-${productId}`;
  const jobs = [];

  if (isNew) {
    jobs.push(notify(viewers, `Новый товар · ${sellerName}`, `${p.name} — ${money(p.price)}, в наличии ${stock}`, tag));
  } else if (stock > prev) {
    jobs.push(notify(viewers, `Поступление · ${sellerName}`, `${p.name}: +${stock - prev}, всего ${stock}. Цена ${money(p.price)}`, tag));
  } else if (prevPrice != null && Number(prevPrice) !== Number(p.price)) {
    jobs.push(notify(viewers, `Новая цена · ${sellerName}`, `${p.name}: ${money(prevPrice)} → ${money(p.price)}`, tag));
  }

  if (!isNew && stock <= LOW_STOCK && prev > LOW_STOCK) {
    jobs.push(notify([sellerId], stock <= 0 ? 'Товар закончился' : 'Товар заканчивается', `${p.name}: осталось ${stock}`, `low-${productId}`));
  }

  await Promise.all(jobs);
  return Response.json({ ok: true });
};
