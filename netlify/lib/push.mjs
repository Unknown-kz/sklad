// Общий код серверных функций: подключение к Firebase и отправка push
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

// Ключи берутся из переменных окружения Netlify (см. README, шаг 6)
const app = getApps()[0] || initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  }),
});

export const auth = getAuth(app);
export const db = getFirestore(app);
export const LOW_STOCK = 5;                 // «заканчивается», если остаток ≤ этого числа
export const TIME_ZONE = 'Asia/Qyzylorda';  // UTC+5, Казахстан
export const money = (n) => Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₸';

export async function notify(uids, title, body, tag = '') {
  const targets = [];
  for (const uid of new Set(uids)) {
    const snap = await db.collection(`users/${uid}/tokens`).get();
    snap.forEach((d) => targets.push({ uid, token: d.id }));
  }
  for (let i = 0; i < targets.length; i += 500) {
    const chunk = targets.slice(i, i + 500);
    const res = await getMessaging().sendEachForMulticast({
      tokens: chunk.map((t) => t.token),
      data: { title, body, tag },
      webpush: { headers: { Urgency: 'high', TTL: '86400' } },
    });
    // Удаляем токены устройств, где приложение удалено или подписка истекла
    await Promise.all(res.responses.map((r, j) => {
      const code = r.error?.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        return db.doc(`users/${chunk[j].uid}/tokens/${chunk[j].token}`).delete();
      }
      return null;
    }));
  }
  return targets.length;
}
