// Каждый день в 21:00 по Казахстану (16:00 UTC) — итоги дня каждому продавцу
import { db, notify, money, TIME_ZONE } from '../lib/push.mjs';

export default async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date()); // YYYY-MM-DD
  const sellers = await db.collection('sellers').get();
  for (const s of sellers.docs) {
    const ops = await db.collection(`sellers/${s.id}/transactions`).where('date', '==', today).get();
    if (ops.empty) continue;
    let sales = 0; let buys = 0; let n = 0;
    ops.forEach((d) => {
      const o = d.data();
      if (o.type === 'sale') { sales += Number(o.total || 0); n += 1; } else buys += Number(o.total || 0);
    });
    await notify([s.id], 'Итоги дня', `Продажи: ${money(sales)} (${n} опер.), закуп: ${money(buys)}`, `day-${today}`);
  }
  return new Response('ok');
};

// Время в UTC: 16:00 UTC = 21:00 в Казахстане
export const config = { schedule: '0 16 * * *' };
