// API приложения: /api/<действие>
import crypto from 'node:crypto';
import {
  store, getJSON, update, HttpError, secrets, signToken, verifyToken,
  hashPassword, checkPassword, notify, money, LOW_STOCK,
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
const str = (v, name, max = 100) => {
  const s = String(v ?? '').trim();
  if (!s) bad(`Укажите: ${name}`);
  if (s.length > max) bad(`Слишком длинно: ${name}`);
  return s;
};
const id = (v) => (/^[\w-]{1,64}$/.test(String(v ?? '')) ? String(v) : bad('Неверный идентификатор'));
const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : bad('Неверная дата'));
const at = (v) => (Number.isFinite(Number(v)) && Math.abs(Number(v) - Date.now()) < 400 * 864e5 ? Number(v) : Date.now());
const byName = (a, b) => a.name.localeCompare(b.name, 'ru');
const newId = () => crypto.randomBytes(9).toString('base64url');
const emailKey = (e) => 'login:' + crypto.createHash('sha256').update(e).digest('hex').slice(0, 40);
const sk = (uid) => `seller:${uid}`;

const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function createCode(sellerId, sellerName) {
  for (let i = 0; i < 20; i++) {
    const c = Array.from({ length: 6 }, () => CODE_ABC[crypto.randomInt(CODE_ABC.length)]).join('');
    const r = await store().setJSON(`code:${c}`, { sellerId, sellerName }, { onlyIfNew: true });
    if (r.modified) return c;
  }
  return bad('Не удалось создать код', 500);
}

function sellerView(s) {
  return {
    name: s.name,
    code: s.code,
    products: Object.values(s.products).sort(byName),
    viewers: Object.entries(s.viewers).map(([vid, v]) => ({ id: vid, ...v })),
  };
}

async function ensureSeller(uid, name) {
  let s = await getJSON(sk(uid));
  if (!s) {
    const code = await createCode(uid, name);
    s = await update(sk(uid), (cur) => cur ?? { name, code, products: {}, viewers: {}, recent: [] });
  }
  return s;
}

async function addOp(uid, d, op) {
  await update(`ops:${uid}:${d}`, (list) => {
    const l = list || [];
    if (l.some((o) => o.id === op.id)) return undefined;
    l.push(op);
    return l;
  });
}

// Push после изменения товара: магазинам — новинка/поступление/цена, продавцу — «заканчивается»
async function pushProduct(sellerId, s, before, after) {
  if (!after) return;
  const viewers = Object.keys(s.viewers || {});
  const tag = `p-${after.id}`;
  const jobs = [];
  if (!before) {
    jobs.push(notify(viewers, `Новый товар · ${s.name}`, `${after.name} — ${money(after.price)}, в наличии ${after.stock}`, tag));
  } else if (after.stock > before.stock) {
    jobs.push(notify(viewers, `Поступление · ${s.name}`, `${after.name}: +${r3(after.stock - before.stock)}, всего ${after.stock}. Цена ${money(after.price)}`, tag));
  } else if (after.price !== before.price) {
    jobs.push(notify(viewers, `Новая цена · ${s.name}`, `${after.name}: ${money(before.price)} → ${money(after.price)}`, tag));
  }
  if (before && after.stock <= LOW_STOCK && before.stock > LOW_STOCK) {
    jobs.push(notify([sellerId], after.stock <= 0 ? 'Товар закончился' : 'Товар заканчивается', `${after.name}: осталось ${after.stock}`, `low-${after.id}`));
  }
  try { await Promise.all(jobs); } catch (e) { console.error('push', e); }
}

/* ---------- без входа ---------- */
const PUBLIC = {
  async register(b) {
    const email = str(b.email, 'email', 200).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('Неверный email');
    const password = String(b.password || '');
    if (password.length < 6) bad('Пароль — минимум 6 символов');
    const name = str(b.name, 'название');
    const role = b.role === 'store' ? 'store' : 'seller';
    const uid = newId();
    const r = await store().setJSON(emailKey(email), { uid, ...hashPassword(password) }, { onlyIfNew: true });
    if (!r.modified) bad('Этот email уже зарегистрирован — войдите', 409);
    await store().setJSON(`user:${uid}`, { uid, email, name, role, createdAt: Date.now() });
    if (role === 'seller') await ensureSeller(uid, name);
    return { token: await signToken({ uid, role }) };
  },

  async login(b) {
    const email = str(b.email, 'email', 200).toLowerCase();
    const rec = await getJSON(emailKey(email));
    if (!rec || !checkPassword(String(b.password || ''), rec.salt, rec.hash)) bad('Неверный email или пароль');
    const me = await getJSON(`user:${rec.uid}`);
    if (!me) bad('Аккаунт повреждён, зарегистрируйтесь заново');
    return { token: await signToken({ uid: rec.uid, role: me.role }) };
  },

  async vapid() {
    return { key: (await secrets()).vapidPublic };
  },
};

/* ---------- любой вошедший ---------- */
const COMMON = {
  async state(u) {
    const me = await getJSON(`user:${u.uid}`);
    if (!me) bad('Войдите заново', 401);
    if (me.role === 'seller') return { me, ...sellerView(await ensureSeller(u.uid, me.name)) };

    const links = (await getJSON(`links:${u.uid}`)) || [];
    const sellers = await Promise.all(links.map(async (l) => {
      const s = await getJSON(sk(l.sellerId));
      const access = !!s?.viewers?.[u.uid];
      return {
        id: l.sellerId,
        name: s?.name || l.sellerName,
        code: l.code,
        access,
        // магазину не показываем цену закупа
        products: access ? Object.values(s.products).map(({ id: pid, name, price, stock }) => ({ id: pid, name, price, stock })).sort(byName) : [],
      };
    }));
    return { me, sellers };
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

/* ---------- продавец ---------- */
const SELLER = {
  async product(u, b) {
    const name = str(b.name, 'название');
    const price = num(b.price, 'цена');
    const stock = r3(num(b.stock ?? 0, 'остаток'));
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
    const stock = r3(num(b.stock, 'остаток'));
    let before;
    const s = await update(sk(u.uid), (cur) => {
      const p = cur.products[pid] || bad('Товар не найден', 404);
      if (Object.values(cur.products).some((x) => x.id !== pid && x.name.toLowerCase() === name.toLowerCase())) {
        bad('Товар с таким названием уже есть');
      }
      before = { ...p };
      Object.assign(p, { name, price, stock, updatedAt: Date.now() });
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
      if (!p) return undefined; // товар удалён — просто убираем запись
      if (p.stock + delta < 0) bad('Нельзя отменить: остаток станет меньше нуля');
      p.stock = r3(p.stock + delta);
      p.updatedAt = Date.now();
      return cur;
    });
    await update(`ops:${u.uid}:${d}`, (l) => (l ? l.filter((o) => o.id !== opId) : undefined));
    return sellerView(s);
  },

  async newcode(u) {
    const me = await getJSON(`user:${u.uid}`);
    const code = await createCode(u.uid, me.name);
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
      if (qty > p.stock) bad(`Недостаточно «${p.name}»: остаток ${p.stock}`);
      p.stock = r3(p.stock - qty);
    } else {
      p.stock = r3(p.stock + qty);
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

/* ---------- магазин ---------- */
const STORE = {
  async join(u, b) {
    const code = str(b.code, 'код', 12).toUpperCase();
    const c = await getJSON(`code:${code}`);
    if (!c) bad('Код не найден. Проверьте у продавца.', 404);
    const me = await getJSON(`user:${u.uid}`);
    await update(sk(c.sellerId), (cur) => {
      if (!cur) bad('Продавец не найден', 404);
      if (cur.code !== code) bad('Код устарел — попросите новый у продавца');
      cur.viewers[u.uid] = { name: me.name, joinedAt: Date.now() };
      return cur;
    });
    await update(`links:${u.uid}`, (list) => {
      const l = (list || []).filter((x) => x.sellerId !== c.sellerId);
      l.push({ sellerId: c.sellerId, sellerName: c.sellerName, code });
      return l;
    });
    return COMMON.state(u);
  },

  async unlink(u, b) {
    const sid = id(b.sellerId);
    await update(sk(sid), (cur) => {
      if (!cur?.viewers?.[u.uid]) return undefined;
      delete cur.viewers[u.uid];
      return cur;
    });
    await update(`links:${u.uid}`, (list) => (list ? list.filter((x) => x.sellerId !== sid) : undefined));
    return COMMON.state(u);
  },
};

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
    if (!user) return Response.json({ error: 'Войдите заново' }, { status: 401 });

    const table = user.role === 'seller' ? SELLER : STORE;
    const fn = Object.hasOwn(COMMON, action) ? COMMON[action] : Object.hasOwn(table, action) ? table[action] : null;
    if (!fn) return Response.json({ error: 'Неизвестное действие' }, { status: 404 });
    return Response.json(await fn(user, body));
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    return Response.json({ error: status === 500 ? 'Ошибка сервера, попробуйте ещё раз' : e.message }, { status });
  }
};

export const config = { path: '/api/*' };
