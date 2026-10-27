// API приложения: /api/<действие>
// Без регистрации: человек вводит имя, и этот телефон получает свой ключ доступа.
// Любой может открыть свой магазин (получает 6-значный код) и подключаться к чужим по коду.
import crypto from 'node:crypto';
import {
  store, getJSON, update, HttpError, secrets, signToken, verifyToken, notify, money, LOW_STOCK,
} from '../lib/core.mjs';

/* ---------- проверка входных данных ---------- */
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e12) bad(`Неверное значение: ${name}`);
  return n;
};
const str = (v, name, max = 60) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!s) bad(`Укажите: ${name}`);
  if (s.length > max) bad(`Слишком длинно: ${name}`);
  return s;
};
const id = (v) => (/^[\w-]{1,64}$/.test(String(v ?? '')) ? String(v) : bad('Неверный идентификатор'));
const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : bad('Неверная дата'));
const at = (v) => (Number.isFinite(Number(v)) && Math.abs(Number(v) - Date.now()) < 400 * 864e5 ? Number(v) : Date.now());
const byName = (a, b) => a.name.localeCompare(b.name, 'ru');
const newId = () => crypto.randomBytes(9).toString('base64url');
const sk = (uid) => `seller:${uid}`;

const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих 0/O, 1/I
const randCode = (n) => Array.from({ length: n }, () => ABC[crypto.randomInt(ABC.length)]).join('');
const cleanCode = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function createCode(sellerId, sellerName) {
  for (let i = 0; i < 20; i++) {
    const c = randCode(6);
    const r = await store().setJSON(`code:${c}`, { sellerId, sellerName }, { onlyIfNew: true });
    if (r.modified) return c;
  }
  return bad('Не удалось создать код', 500);
}

async function createUser(name) {
  const uid = newId();
  let restoreKey;
  for (let i = 0; i < 20 && !restoreKey; i++) {
    const k = randCode(8);
    const r = await store().setJSON(`restore:${k}`, { uid }, { onlyIfNew: true });
    if (r.modified) restoreKey = k;
  }
  if (!restoreKey) bad('Не удалось создать ключ', 500);
  const me = { uid, name, restoreKey, createdAt: Date.now() };
  await store().setJSON(`user:${uid}`, me);
  return me;
}

function sellerView(s) {
  return {
    name: s.name,
    owner: s.owner,
    code: s.code,
    products: Object.values(s.products).sort(byName),
    viewers: Object.entries(s.viewers).map(([vid, v]) => ({ id: vid, ...v })),
  };
}

async function openShop(me, shopName) {
  if (await getJSON(sk(me.uid))) bad('У вас уже есть магазин');
  const code = await createCode(me.uid, shopName);
  await update(sk(me.uid), (cur) => cur ?? {
    name: shopName, owner: me.name, code, products: {}, viewers: {}, recent: [], createdAt: Date.now(),
  });
}

async function joinShop(me, rawCode) {
  const code = cleanCode(rawCode);
  if (code.length !== 6) bad('Код — 6 символов');
  const c = await getJSON(`code:${code}`);
  if (!c) bad('Код не найден. Проверьте у владельца магазина.', 404);
  if (c.sellerId === me.uid) bad('Это код вашего собственного магазина');
  await update(sk(c.sellerId), (cur) => {
    if (!cur) bad('Магазин не найден', 404);
    if (cur.code !== code) bad('Код устарел — попросите новый');
    cur.viewers[me.uid] = { name: me.name, joinedAt: Date.now() };
    return cur;
  });
  await update(`links:${me.uid}`, (list) => {
    const l = (list || []).filter((x) => x.sellerId !== c.sellerId);
    l.push({ sellerId: c.sellerId, sellerName: c.sellerName, code });
    return l;
  });
}

async function state(uid) {
  const me = await getJSON(`user:${uid}`);
  if (!me) bad('Войдите заново', 401);
  const own = await getJSON(sk(uid));
  const links = (await getJSON(`links:${uid}`)) || [];
  const joined = await Promise.all(links.map(async (l) => {
    const s = await getJSON(sk(l.sellerId));
    const access = !!s?.viewers?.[uid];
    return {
      id: l.sellerId,
      name: s?.name || l.sellerName,
      owner: s?.owner || '',
      code: l.code,
      access,
      // подключённым не показываем цену закупа
      products: access
        ? Object.values(s.products).map(({ id: pid, name, price, stock }) => ({ id: pid, name, price, stock })).sort(byName)
        : [],
    };
  }));
  return { me, shop: own ? sellerView(own) : null, joined };
}

async function addOp(uid, d, op) {
  await update(`ops:${uid}:${d}`, (list) => {
    const l = list || [];
    if (l.some((o) => o.id === op.id)) return undefined;
    l.push(op);
    return l;
  });
}

const hasStock = (p) => typeof p?.stock === 'number';

// Push после изменения товара: подключённым — новинка/поступление/цена, владельцу — «заканчивается»
async function pushProduct(sellerId, s, before, after) {
  if (!after) return;
  const viewers = Object.keys(s.viewers || {});
  const tag = `p-${after.id}`;
  const jobs = [];
  if (!before) {
    jobs.push(notify(viewers, `Новый товар · ${s.name}`, `${after.name} — ${money(after.price)}${hasStock(after) ? `, в наличии ${after.stock}` : ''}`, tag));
  } else if (hasStock(after) && hasStock(before) && after.stock > before.stock) {
    jobs.push(notify(viewers, `Поступление · ${s.name}`, `${after.name}: +${r3(after.stock - before.stock)}, всего ${after.stock}. Цена ${money(after.price)}`, tag));
  } else if (after.price !== before.price) {
    jobs.push(notify(viewers, `Новая цена · ${s.name}`, `${after.name}: ${money(before.price)} → ${money(after.price)}`, tag));
  }
  if (hasStock(after) && hasStock(before) && after.stock <= LOW_STOCK && before.stock > LOW_STOCK) {
    jobs.push(notify([sellerId], after.stock <= 0 ? 'Товар закончился' : 'Товар заканчивается', `${after.name}: осталось ${after.stock}`, `low-${after.id}`));
  }
  try { await Promise.all(jobs); } catch (e) { console.error('push', e); }
}

/* ---------- без входа ---------- */
const PUBLIC = {
  // Первый вход: имя + (название магазина ИЛИ код для подключения)
  async start(b) {
    const name = str(b.name, 'ваше имя', 40);
    const shopName = b.shopName ? str(b.shopName, 'название магазина') : null;
    const code = b.code ? cleanCode(b.code) : null;
    if (!shopName && !code) bad('Укажите название магазина или код');
    if (code) {
      // проверяем код до создания пользователя, чтобы не плодить пустых
      if (code.length !== 6) bad('Код — 6 символов');
      if (!(await getJSON(`code:${code}`))) bad('Код не найден. Проверьте у владельца магазина.', 404);
    }
    const me = await createUser(name);
    if (shopName) await openShop(me, shopName);
    if (code) await joinShop(me, code);
    return { token: await signToken({ uid: me.uid }), ...(await state(me.uid)) };
  },

  // Вход на другом телефоне по ключу восстановления
  async restore(b) {
    const key = cleanCode(b.key);
    const r = key.length === 8 ? await getJSON(`restore:${key}`) : null;
    if (!r) bad('Ключ не найден. Проверьте 8 символов.');
    return { token: await signToken({ uid: r.uid }), ...(await state(r.uid)) };
  },

  async vapid() {
    return { key: (await secrets()).vapidPublic };
  },
};

/* ---------- любой вошедший ---------- */
const COMMON = {
  state: (u) => state(u.uid),

  async open(u, b) {
    const me = await getJSON(`user:${u.uid}`);
    await openShop(me, str(b.shopName, 'название магазина'));
    return state(u.uid);
  },

  async join(u, b) {
    const me = await getJSON(`user:${u.uid}`);
    await joinShop(me, b.code);
    return state(u.uid);
  },

  async unlink(u, b) {
    const sid = id(b.sellerId);
    await update(sk(sid), (cur) => {
      if (!cur?.viewers?.[u.uid]) return undefined;
      delete cur.viewers[u.uid];
      return cur;
    });
    await update(`links:${u.uid}`, (list) => (list ? list.filter((x) => x.sellerId !== sid) : undefined));
    return state(u.uid);
  },

  async subscribe(u, b) {
    const sub = b.subscription;
    if (!sub?.endpoint?.startsWith('https://') || !sub?.keys?.p256dh || !sub?.keys?.auth) bad('Неверная подписка');
    await update(`push:${u.uid}`, (list) => {
      const l = (list || []).filter((s) => s.endpoint !== sub.endpoint);
      l.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
      return l.slice(-10);
    });
    return { ok: true };
  },

  async unsubscribe(u, b) {
    await update(`push:${u.uid}`, (list) => (list ? list.filter((s) => s.endpoint !== b.endpoint) : undefined));
    return { ok: true };
  },
};

/* ---------- владелец своего магазина ---------- */
const SELLER = {
  async product(u, b) {
    const name = str(b.name, 'название');
    const price = num(b.price, 'цена');
    const stock = b.stock == null || b.stock === '' ? null : r3(num(b.stock, 'остаток'));
    const cost = num(b.cost || 0, 'цена закупа');
    const d = date(b.date);
    const pid = newId();
    const s = await update(sk(u.uid), (cur) => {
      if (Object.values(cur.products).some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        bad('Такой товар уже есть — используйте «Закуп»');
      }
      if (Object.keys(cur.products).length >= 3000) bad('Слишком много товаров');
      cur.products[pid] = { id: pid, name, price, stock, cost, updatedAt: Date.now() };
      return cur;
    });
    if (stock > 0 && cost > 0) {
      await addOp(u.uid, d, { id: newId(), type: 'purchase', productId: pid, productName: name, qty: stock, price: cost, total: r2(stock * cost), at: at(b.at) });
    }
    await pushProduct(u.uid, s, null, s.products[pid]);
    return sellerView(s);
  },

  async edit(u, b) {
    const pid = id(b.id);
    const name = str(b.name, 'название');
    const price = num(b.price, 'цена');
    const newStock = b.stock == null || b.stock === '' ? undefined : r3(num(b.stock, 'остаток'));
    let before;
    const s = await update(sk(u.uid), (cur) => {
      const p = cur.products[pid] || bad('Товар не найден', 404);
      if (Object.values(cur.products).some((x) => x.id !== pid && x.name.toLowerCase() === name.toLowerCase())) {
        bad('Товар с таким названием уже есть');
      }
      before = { ...p };
      Object.assign(p, { name, price, updatedAt: Date.now() });
      if (newStock !== undefined) p.stock = newStock;
      return cur;
    });
    await pushProduct(u.uid, s, before, s.products[pid]);
    return sellerView(s);
  },

  async remove(u, b) {
    const pid = id(b.id);
    const s = await update(sk(u.uid), (cur) => {
      if (!cur.products[pid]) return undefined;
      delete cur.products[pid];
      return cur;
    });
    return sellerView(s);
  },

  // Продажа и закуп приходят с идентификатором операции: повторная отправка
  // (например, после пропажи интернета) не спишет товар дважды.
  async sale(u, b) { return move(u, b, 'sale'); },
  async purchase(u, b) { return move(u, b, 'purchase'); },

  async ops(u, b) {
    const list = (await getJSON(`ops:${u.uid}:${date(b.date)}`)) || [];
    return { ops: list.sort((x, y) => y.at - x.at) };
  },

  async cancel(u, b) {
    const d = date(b.date);
    const opId = id(b.opId);
    const list = (await getJSON(`ops:${u.uid}:${d}`)) || [];
    const op = list.find((o) => o.id === opId) || bad('Операция не найдена', 404);
    const delta = op.type === 'sale' ? op.qty : -op.qty;
    const s = await update(sk(u.uid), (cur) => {
      const p = cur.products[op.productId];
      if (!p || !hasStock(p)) return undefined; // товар удалён или остатки не ведутся — просто убираем запись
      if (p.stock + delta < 0) bad('Нельзя отменить: остаток станет меньше нуля');
      p.stock = r3(p.stock + delta);
      p.updatedAt = Date.now();
      return cur;
    });
    await update(`ops:${u.uid}:${d}`, (l) => (l ? l.filter((o) => o.id !== opId) : undefined));
    return sellerView(s);
  },

  async newcode(u) {
    const shop = await getJSON(sk(u.uid));
    const code = await createCode(u.uid, shop.name);
    let old;
    const s = await update(sk(u.uid), (cur) => { old = cur.code; cur.code = code; return cur; });
    if (old && old !== code) await store().delete(`code:${old}`);
    return sellerView(s);
  },

  async kick(u, b) {
    const vid = id(b.storeId);
    const s = await update(sk(u.uid), (cur) => {
      if (!cur.viewers[vid]) return undefined;
      delete cur.viewers[vid];
      return cur;
    });
    return sellerView(s);
  },
};

async function move(u, b, type) {
  const pid = id(b.id);
  const opId = id(b.opId);
  const d = date(b.date);
  const qty = r3(num(b.qty, 'количество'));
  if (qty <= 0) bad('Укажите количество');
  const price = num(type === 'sale' ? b.price : b.cost, 'цена');
  let before; let dup = false;
  const s = await update(sk(u.uid), (cur) => {
    dup = false;
    if ((cur.recent || []).includes(opId)) { dup = true; return undefined; }
    const p = cur.products[pid] || bad('Товар не найден (удалён?)', 404);
    before = { ...p };
    if (type === 'sale') {
      if (hasStock(p)) {
        if (qty > p.stock) bad(`Недостаточно «${p.name}»: остаток ${p.stock}`);
        p.stock = r3(p.stock - qty);
      }
    } else {
      p.stock = r3((hasStock(p) ? p.stock : 0) + qty);
      p.cost = price;
      if (b.price != null && b.price !== '') p.price = num(b.price, 'цена продажи');
    }
    p.updatedAt = Date.now();
    cur.recent = [...(cur.recent || []), opId].slice(-500);
    return cur;
  });
  if (!dup) {
    await addOp(u.uid, d, {
      id: opId, type, productId: pid, productName: before.name, qty, price, total: r2(qty * price), at: at(b.at),
    });
    await pushProduct(u.uid, s, before, s.products[pid]);
  }
  return sellerView(s);
}

/* ---------- маршрутизация ---------- */
export default async (req) => {
  try {
    const url = new URL(req.url);
    const action = url.pathname.split('/').filter(Boolean)[1] || '';
    const body = req.method === 'POST'
      ? await req.json().catch(() => ({}))
      : Object.fromEntries(url.searchParams);

    if (Object.hasOwn(PUBLIC, action)) return Response.json(await PUBLIC[action](body));

    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const user = await verifyToken(token);
    if (!user?.uid) return Response.json({ error: 'Войдите заново' }, { status: 401 });

    if (Object.hasOwn(COMMON, action)) return Response.json(await COMMON[action](user, body));
    if (Object.hasOwn(SELLER, action)) {
      // действия с товарами — только в своём магазине
      if (!(await getJSON(sk(user.uid)))) bad('Сначала откройте свой магазин', 403);
      return Response.json(await SELLER[action](user, body));
    }
    return Response.json({ error: 'Неизвестное действие' }, { status: 404 });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    return Response.json({ error: status === 500 ? 'Ошибка сервера, попробуйте ещё раз' : e.message }, { status });
  }
};

export const config = { path: '/api/*' };
