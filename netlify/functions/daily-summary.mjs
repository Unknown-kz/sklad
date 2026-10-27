// Каждый день в 21:00 по Казахстану (16:00 UTC) — итоги дня каждому продавцу
import { store, getJSON, notify, money, TIME_ZONE } from '../lib/core.mjs';

export default async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date()); // YYYY-MM-DD
  const { blobs } = await store().list({ prefix: 'seller:' });
  for (const { key } of blobs) {
    const sellerId = key.slice('seller:'.length);
    const ops = (await getJSON(`ops:${sellerId}:${today}`)) || [];
    if (!ops.length) continue;
    let sales = 0; let buys = 0; let n = 0;
    for (const o of ops) {
      if (o.type === 'sale') { sales += Number(o.total || 0); n += 1; } else buys += Number(o.total || 0);
    }
    await notify([sellerId], 'Итоги дня', `Продажи: ${money(sales)} (${n} опер.)${buys ? `, закуп: ${money(buys)}` : ''}`, `day-${today}`);
  }
  return new Response('ok');
};

// Время в UTC: 16:00 UTC = 21:00 в Казахстане
export const config = { schedule: '0 16 * * *' };
