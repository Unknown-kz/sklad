// Склад — PWA: товары, цены, остатки, продажи, закуп, доступ магазинов по коду, push.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, collection, onSnapshot, query, where,
  writeBatch, serverTimestamp, increment,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  getMessaging, getToken, onMessage, isSupported,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js';

/* ------------------------------------------------------------------ */
/*  Утилиты                                                            */
/* ------------------------------------------------------------------ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₸';
const qtyFmt = (n) => Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const LOW_STOCK = 5;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

// Запись сразу видна в интерфейсе (локальный кэш), а на сервер уходит,
// как только появится интернет — поэтому продавать можно и офлайн.
function commit(batch, okMsg, after) {
  batch.commit().then(after).catch((e) => toast('Не сохранилось: ' + e.message));
  if (okMsg) toast(okMsg);
}

// Сообщить серверу (Netlify Function) об изменении товара, чтобы он разослал push.
// Вызываем только когда уведомление действительно нужно — экономим лимиты.
function pushEvent({ productId, isNew = false, prevStock = 0, prevPrice = null, newStock, newPrice }) {
  const toStores = S.viewers.length > 0
    && (isNew || newStock > prevStock || (prevPrice != null && newPrice !== prevPrice));
  const toMe = !isNew && newStock <= LOW_STOCK && prevStock > LOW_STOCK;
  if (!toStores && !toMe) return undefined;
  return async () => {
    try {
      const token = await auth.currentUser.getIdToken();
      await fetch('/.netlify/functions/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ productId, isNew, prevStock, prevPrice }),
      });
    } catch (e) { console.warn('push', e); }
  };
}

function genCode() {
  const r = crypto.getRandomValues(new Uint32Array(6));
  return Array.from(r, (x) => CODE_ABC[x % CODE_ABC.length]).join('');
}

/* ------------------------------------------------------------------ */
/*  Service worker, сеть, установка                                    */
/* ------------------------------------------------------------------ */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}

const setNet = () => { $('#net').textContent = navigator.onLine ? '' : 'офлайн'; };
addEventListener('online', setNet);
addEventListener('offline', setNet);
setNet();

let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#install-card').hidden = false;
});
$('#install').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  installPrompt = null;
  $('#install-card').hidden = true;
};

/* ------------------------------------------------------------------ */
/*  Firebase                                                           */
/* ------------------------------------------------------------------ */
const cfg = self.FIREBASE_CONFIG || {};
if (!cfg.apiKey || cfg.apiKey.startsWith('ВСТАВЬТЕ')) {
  $('main').innerHTML = `<div class="card setup">
    <h3>Почти готово</h3>
    <p>Откройте файл <b>firebase-config.js</b> и вставьте настройки вашего проекта Firebase.
    Пошаговая инструкция — в <b>README.md</b>.</p></div>`;
  throw new Error('firebase-config.js не заполнен');
}

const fbApp = initializeApp(cfg);
const auth = getAuth(fbApp);
const db = initializeFirestore(fbApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
const messaging = (await isSupported().catch(() => false)) ? getMessaging(fbApp) : null;

/* ------------------------------------------------------------------ */
/*  Состояние                                                          */
/* ------------------------------------------------------------------ */
const S = {
  uid: null, profile: null, seller: null,
  products: [], ops: [], viewers: [],
  links: [], storeProducts: {}, linkSubs: {},
  subs: [], opsSub: null,
  filter: 'all', date: ymd(),
};

const productsCol = () => collection(db, 'sellers', S.uid, 'products');
const opsCol = () => collection(db, 'sellers', S.uid, 'transactions');
const pRef = (id) => doc(db, 'sellers', S.uid, 'products', id);

function stopAll() {
  S.subs.forEach((u) => u());
  Object.values(S.linkSubs).forEach((u) => u());
  S.opsSub?.();
  Object.assign(S, {
    profile: null, seller: null, products: [], ops: [], viewers: [],
    links: [], storeProducts: {}, linkSubs: {}, subs: [], opsSub: null, filter: 'all',
  });
}

/* ------------------------------------------------------------------ */
/*  Навигация                                                          */
/* ------------------------------------------------------------------ */
const TABS = {
  seller: [['products', '📦', 'Товары'], ['report', '📊', 'Отчёт'], ['profile', '👤', 'Профиль']],
  store: [['catalog', '🛒', 'Каталог'], ['sellers', '🏪', 'Продавцы'], ['profile', '👤', 'Профиль']],
};
const TITLES = {
  auth: 'Склад', products: 'Товары', report: 'Продажи и закуп за день',
  catalog: 'Каталог', sellers: 'Мои продавцы', profile: 'Профиль',
};

function show(view) {
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'v-' + view));
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  $('#title').textContent = TITLES[view] || 'Склад';
  scrollTo(0, 0);
}

function buildTabs(role) {
  const tabs = $('#tabs');
  tabs.hidden = !role;
  tabs.innerHTML = role
    ? TABS[role].map(([v, i, l]) => `<button type="button" data-view="${v}"><span>${i}</span>${l}</button>`).join('')
    : '';
}
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) show(b.dataset.view);
});

/* ------------------------------------------------------------------ */
/*  Диалог-форма                                                       */
/* ------------------------------------------------------------------ */
function form({ title, fields, submit = 'Сохранить', hint, onSubmit, extra }) {
  const dlg = $('#dlg');
  const f = $('#dlg-form');
  f.innerHTML = `
    <h2>${esc(title)}</h2>
    ${fields.map((fl) => `
      <label>${esc(fl.label)}
        <input name="${fl.name}" type="${fl.type || 'text'}"
          ${fl.type === 'number' ? 'inputmode="decimal" step="any"' : ''}
          ${fl.required ? 'required' : ''} ${fl.min != null ? `min="${fl.min}"` : ''}
          value="${esc(fl.value ?? '')}" placeholder="${esc(fl.placeholder || '')}" autocomplete="off">
      </label>`).join('')}
    <p class="hint" id="dlg-hint"></p>
    <p class="err" id="dlg-err"></p>
    <div class="row">
      ${extra ? `<button type="button" class="btn danger" id="dlg-extra">${esc(extra.label)}</button><span class="spacer"></span>` : ''}
      <button type="button" class="btn" id="dlg-cancel">Отмена</button>
      <button type="submit" class="btn primary">${esc(submit)}</button>
    </div>`;
  const values = () => Object.fromEntries(new FormData(f));
  const upd = () => { $('#dlg-hint').textContent = hint ? hint(values()) : ''; };
  f.oninput = upd;
  upd();
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { await onSubmit(values()); dlg.close(); } catch (err) { $('#dlg-err').textContent = err.message; }
  };
  $('#dlg-cancel').onclick = () => dlg.close();
  if (extra) {
    $('#dlg-extra').onclick = async () => {
      try { if (await extra.onClick()) dlg.close(); } catch (err) { $('#dlg-err').textContent = err.message; }
    };
  }
  dlg.showModal();
  f.querySelector('input')?.focus();
}

/* ------------------------------------------------------------------ */
/*  Вход и регистрация                                                 */
/* ------------------------------------------------------------------ */
let authMode = 'login';
function setAuthMode(mode, note = '') {
  authMode = mode;
  $$('[data-auth]').forEach((x) => x.classList.toggle('on', x.dataset.auth === mode));
  $('#f-auth').classList.toggle('register', mode === 'register');
  $('#f-auth [type=submit]').textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
  $('#auth-note').textContent = note;
  $('#auth-err').textContent = '';
}
$$('[data-auth]').forEach((b) => { b.onclick = () => setAuthMode(b.dataset.auth); });

const AUTH_ERR = {
  'auth/invalid-credential': 'Неверный email или пароль',
  'auth/wrong-password': 'Неверный пароль',
  'auth/user-not-found': 'Пользователь не найден',
  'auth/email-already-in-use': 'Этот email уже зарегистрирован — войдите',
  'auth/weak-password': 'Пароль — минимум 6 символов',
  'auth/invalid-email': 'Неверный email',
  'auth/network-request-failed': 'Нет интернета',
  'auth/too-many-requests': 'Слишком много попыток, подождите',
  name: 'Укажите название',
};

$('#f-auth').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = e.target.querySelector('[type=submit]');
  btn.disabled = true;
  $('#auth-err').textContent = '';
  try {
    if (authMode === 'login') {
      await signInWithEmailAndPassword(auth, f.get('email').trim(), f.get('password'));
    } else {
      const name = String(f.get('name') || '').trim();
      if (!name) throw { code: 'name' };
      const data = { role: f.get('role'), name };
      // Аккаунт уже есть, но профиль не создан (например, оборвался интернет)
      const user = auth.currentUser
        || (await createUserWithEmailAndPassword(auth, f.get('email').trim(), f.get('password'))).user;
      await createProfile(user, data);
    }
  } catch (err) {
    $('#auth-err').textContent = AUTH_ERR[err.code] || err.message || 'Ошибка';
  } finally {
    btn.disabled = false;
  }
});

async function freeCode() {
  for (let i = 0; i < 10; i++) {
    const c = genCode();
    if (!(await getDoc(doc(db, 'codes', c))).exists()) return c;
  }
  throw new Error('Не удалось создать код, попробуйте ещё раз');
}

async function createProfile(user, { role, name }) {
  const b = writeBatch(db);
  b.set(doc(db, 'users', user.uid), { role, name, email: user.email, createdAt: serverTimestamp() });
  if (role === 'seller') {
    const code = await freeCode();
    b.set(doc(db, 'sellers', user.uid), { name, code, createdAt: serverTimestamp() });
    b.set(doc(db, 'codes', code), { sellerId: user.uid, sellerName: name });
  }
  await b.commit();
}

onAuthStateChanged(auth, (user) => {
  stopAll();
  delete document.body.dataset.role;
  if (!user) {
    S.uid = null;
    buildTabs(null);
    setAuthMode(authMode);
    show('auth');
    return;
  }
  S.uid = user.uid;
  let started = false;
  S.subs.push(onSnapshot(doc(db, 'users', user.uid), (snap) => {
    if (!snap.exists()) {
      // Профиль ещё создаётся — или не был создан. Во втором случае просим дозаполнить.
      if (!snap.metadata.fromCache && !snap.metadata.hasPendingWrites) {
        setAuthMode('register', 'Аккаунт есть, но профиль не заполнен. Выберите роль и название.');
        show('auth');
      }
      return;
    }
    S.profile = snap.data();
    if (!started) { started = true; startApp(); }
    renderProfile();
  }, (err) => toast(err.message)));
});

$('#logout').onclick = () => { if (confirm('Выйти из аккаунта?')) signOut(auth); };

function startApp() {
  const role = S.profile.role;
  document.body.dataset.role = role;
  buildTabs(role);

  if (role === 'seller') {
    S.subs.push(onSnapshot(productsCol(), (snap) => {
      S.products = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      renderProducts();
    }, (err) => toast(err.message)));
    S.subs.push(onSnapshot(doc(db, 'sellers', S.uid), (snap) => {
      S.seller = snap.data() || null;
      renderProfile();
    }));
    S.subs.push(onSnapshot(collection(db, 'sellers', S.uid, 'viewers'), (snap) => {
      S.viewers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderProfile();
    }));
    subscribeOps();
    show('products');
  } else {
    S.subs.push(onSnapshot(collection(db, 'users', S.uid, 'links'), (snap) => {
      S.links = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.sellerName || '').localeCompare(b.sellerName || '', 'ru'));
      syncLinkSubs();
      renderSellers();
      renderCatalog();
    }, (err) => toast(err.message)));
    show('catalog');
  }

  renderPush();
  if (messaging && Notification.permission === 'granted') registerPush(true);
}

/* ------------------------------------------------------------------ */
/*  ПРОДАВЕЦ: товары                                                   */
/* ------------------------------------------------------------------ */
$('#q').addEventListener('input', renderProducts);

function renderProducts() {
  const q = $('#q').value.trim().toLowerCase();
  const list = S.products.filter((p) => !q || p.name.toLowerCase().includes(q));
  const value = S.products.reduce((s, p) => s + num(p.stock) * num(p.price), 0);
  const low = S.products.filter((p) => num(p.stock) <= LOW_STOCK).length;
  $('#p-stats').innerHTML = `
    <span>${S.products.length} товаров</span>
    <span>остатки на ${money(value)}</span>
    ${low ? `<span class="warn">заканчивается: ${low}</span>` : ''}`;
  $('#p-list').innerHTML = list.length
    ? list.map((p) => `
      <li class="item ${num(p.stock) <= 0 ? 'out' : ''}">
        <div class="info">
          <b>${esc(p.name)}</b>
          <small>${money(p.price)} · <span class="${num(p.stock) <= LOW_STOCK ? 'warn' : ''}">остаток ${qtyFmt(p.stock)}</span></small>
        </div>
        <div class="acts">
          <button type="button" class="btn sm primary" data-act="sell" data-id="${p.id}">Продажа</button>
          <button type="button" class="btn sm" data-act="buy" data-id="${p.id}">Закуп</button>
          <button type="button" class="btn sm ghost" data-act="edit" data-id="${p.id}" aria-label="Изменить">✎</button>
        </div>
      </li>`).join('')
    : `<li class="empty">${q ? 'Ничего не найдено' : 'Пока нет товаров. Нажмите «+ Товар».'}</li>`;
}

$('#p-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const p = S.products.find((x) => x.id === b.dataset.id);
  if (!p) return;
  ({ sell: sellDialog, buy: buyDialog, edit: editDialog })[b.dataset.act](p);
});

$('#add-product').onclick = () => form({
  title: 'Новый товар',
  submit: 'Добавить',
  fields: [
    { name: 'name', label: 'Название', required: true, value: $('#q').value.trim() },
    { name: 'price', label: 'Цена продажи, ₸', type: 'number', min: 0, required: true },
    { name: 'stock', label: 'Остаток сейчас', type: 'number', min: 0, value: 0 },
    { name: 'cost', label: 'Цена закупа за шт., ₸ (необязательно)', type: 'number', min: 0 },
  ],
  hint: (v) => (num(v.stock) > 0 && num(v.cost) > 0
    ? `Будет записан закуп на ${money(num(v.stock) * num(v.cost))}` : ''),
  onSubmit: (v) => {
    const name = v.name.trim();
    if (!name) throw new Error('Введите название');
    if (S.products.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new Error('Такой товар уже есть — используйте «Закуп»');
    }
    const stock = num(v.stock); const cost = num(v.cost);
    const ref = doc(productsCol());
    const b = writeBatch(db);
    b.set(ref, {
      name, price: num(v.price), stock, cost,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    if (stock > 0 && cost > 0) b.set(doc(opsCol()), op('purchase', { id: ref.id, name }, stock, cost));
    commit(b, `Добавлено: ${name}`, pushEvent({ productId: ref.id, isNew: true, newStock: stock }));
    $('#q').value = '';
  },
});

function op(type, p, qty, price) {
  return {
    type, productId: p.id, productName: p.name, qty, price,
    total: Math.round(qty * price * 100) / 100,
    date: ymd(), createdAt: serverTimestamp(),
  };
}

function sellDialog(p) {
  form({
    title: `Продажа: ${p.name}`,
    submit: 'Продать',
    fields: [
      { name: 'qty', label: `Количество (в наличии ${qtyFmt(p.stock)})`, type: 'number', min: 0, value: 1, required: true },
      { name: 'price', label: 'Цена за шт., ₸', type: 'number', min: 0, value: p.price, required: true },
    ],
    hint: (v) => `Сумма: ${money(num(v.qty) * num(v.price))}`,
    onSubmit: (v) => {
      const qty = num(v.qty); const price = num(v.price);
      const cur = S.products.find((x) => x.id === p.id);
      if (!cur) throw new Error('Товар удалён');
      if (qty <= 0) throw new Error('Укажите количество');
      if (qty > num(cur.stock)) throw new Error(`Недостаточно товара: остаток ${qtyFmt(cur.stock)}`);
      const b = writeBatch(db);
      b.update(pRef(p.id), { stock: increment(-qty), updatedAt: serverTimestamp() });
      b.set(doc(opsCol()), op('sale', cur, qty, price));
      commit(b, `Продано: ${cur.name} × ${qtyFmt(qty)} = ${money(qty * price)}`, pushEvent({
        productId: cur.id, prevStock: num(cur.stock), newStock: num(cur.stock) - qty,
      }));
    },
  });
}

function buyDialog(p) {
  form({
    title: `Закуп: ${p.name}`,
    submit: 'Записать закуп',
    fields: [
      { name: 'qty', label: `Количество (сейчас ${qtyFmt(p.stock)})`, type: 'number', min: 0, value: '', required: true },
      { name: 'cost', label: 'Цена закупа за шт., ₸', type: 'number', min: 0, value: p.cost || '', required: true },
      { name: 'price', label: 'Цена продажи, ₸', type: 'number', min: 0, value: p.price, required: true },
    ],
    hint: (v) => (num(v.qty) > 0 ? `Закуп на ${money(num(v.qty) * num(v.cost))}, станет ${qtyFmt(num(p.stock) + num(v.qty))} шт.` : ''),
    onSubmit: (v) => {
      const qty = num(v.qty); const cost = num(v.cost);
      const cur = S.products.find((x) => x.id === p.id);
      if (!cur) throw new Error('Товар удалён');
      if (qty <= 0) throw new Error('Укажите количество');
      const b = writeBatch(db);
      b.update(pRef(p.id), {
        stock: increment(qty), cost, price: num(v.price), updatedAt: serverTimestamp(),
      });
      b.set(doc(opsCol()), op('purchase', cur, qty, cost));
      commit(b, `Закуп: ${cur.name} +${qtyFmt(qty)}`, pushEvent({
        productId: cur.id, prevStock: num(cur.stock), newStock: num(cur.stock) + qty,
        prevPrice: num(cur.price), newPrice: num(v.price),
      }));
    },
  });
}

function editDialog(p) {
  form({
    title: 'Изменить товар',
    fields: [
      { name: 'name', label: 'Название', value: p.name, required: true },
      { name: 'price', label: 'Цена продажи, ₸', type: 'number', min: 0, value: p.price, required: true },
      { name: 'stock', label: 'Остаток (корректировка, без записи в отчёт)', type: 'number', min: 0, value: p.stock, required: true },
    ],
    onSubmit: (v) => {
      const name = v.name.trim();
      if (!name) throw new Error('Введите название');
      const b = writeBatch(db);
      b.update(pRef(p.id), { name, price: num(v.price), stock: num(v.stock), updatedAt: serverTimestamp() });
      commit(b, 'Сохранено', pushEvent({
        productId: p.id, prevStock: num(p.stock), newStock: num(v.stock),
        prevPrice: num(p.price), newPrice: num(v.price),
      }));
    },
    extra: {
      label: 'Удалить',
      onClick: () => {
        if (!confirm(`Удалить «${p.name}»? Записи в отчётах останутся.`)) return false;
        const b = writeBatch(db);
        b.delete(pRef(p.id));
        commit(b, 'Товар удалён');
        return true;
      },
    },
  });
}

/* ------------------------------------------------------------------ */
/*  ПРОДАВЕЦ: отчёт за день                                            */
/* ------------------------------------------------------------------ */
function subscribeOps() {
  S.opsSub?.();
  $('#d-date').value = S.date;
  S.opsSub = onSnapshot(query(opsCol(), where('date', '==', S.date)), (snap) => {
    S.ops = snap.docs.map((d) => {
      const data = d.data({ serverTimestamps: 'estimate' });
      return { id: d.id, ...data, ts: data.createdAt?.toMillis?.() ?? Date.now() };
    }).sort((a, b) => b.ts - a.ts);
    renderReport();
  }, (err) => toast(err.message));
}

function shiftDate(n) {
  const d = new Date(S.date + 'T12:00:00');
  d.setDate(d.getDate() + n);
  S.date = ymd(d);
  subscribeOps();
}
$('#d-prev').onclick = () => shiftDate(-1);
$('#d-next').onclick = () => shiftDate(1);
$('#d-date').onchange = (e) => { S.date = e.target.value || ymd(); subscribeOps(); };

function renderReport() {
  const sales = S.ops.filter((o) => o.type === 'sale');
  const buys = S.ops.filter((o) => o.type === 'purchase');
  const sum = (a) => a.reduce((s, o) => s + num(o.total), 0);
  const sS = sum(sales); const sB = sum(buys);

  $('#r-kpis').innerHTML = `
    <div class="kpi sale"><small>Продажи</small><b>${money(sS)}</b><small>${sales.length} опер.</small></div>
    <div class="kpi buy"><small>Закуп</small><b>${money(sB)}</b><small>${buys.length} опер.</small></div>
    <div class="kpi"><small>Разница</small><b class="${sS - sB < 0 ? 'neg' : ''}">${money(sS - sB)}</b><small>продажи − закуп</small></div>`;

  const byItem = new Map();
  for (const o of S.ops) {
    const r = byItem.get(o.productName) || { sq: 0, ss: 0, bq: 0, bs: 0 };
    if (o.type === 'sale') { r.sq += num(o.qty); r.ss += num(o.total); } else { r.bq += num(o.qty); r.bs += num(o.total); }
    byItem.set(o.productName, r);
  }
  const rows = [...byItem.entries()].sort((a, b) => b[1].ss - a[1].ss);
  $('#r-items').innerHTML = rows.length ? `
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Товар</th><th>Продано</th><th>Закуп</th></tr></thead>
      <tbody>${rows.map(([n, r]) => `<tr><td>${esc(n)}</td>
        <td>${r.sq ? `${money(r.ss)}<small>${qtyFmt(r.sq)} шт.</small>` : '—'}</td>
        <td>${r.bq ? `${money(r.bs)}<small>${qtyFmt(r.bq)} шт.</small>` : '—'}</td></tr>`).join('')}</tbody>
    </table></div>` : '<p class="empty">Нет операций за этот день</p>';

  $('#r-ops').innerHTML = S.ops.map((o) => {
    const t = new Date(o.ts);
    return `<li class="item">
      <div class="info">
        <b><span class="tag ${o.type}">${o.type === 'sale' ? 'Продажа' : 'Закуп'}</span>${esc(o.productName)}</b>
        <small>${pad(t.getHours())}:${pad(t.getMinutes())} · ${qtyFmt(o.qty)} × ${money(o.price)}</small>
      </div>
      <div class="price">${money(o.total)}</div>
      <button type="button" class="btn sm ghost" data-cancel="${o.id}" aria-label="Отменить">✕</button>
    </li>`;
  }).join('');
}

$('#r-ops').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cancel]');
  if (!btn) return;
  const o = S.ops.find((x) => x.id === btn.dataset.cancel);
  if (!o) return;
  const p = S.products.find((x) => x.id === o.productId);
  const delta = o.type === 'sale' ? num(o.qty) : -num(o.qty);
  if (p && num(p.stock) + delta < 0) return toast('Нельзя отменить: остаток станет меньше нуля');
  if (!confirm(`Отменить ${o.type === 'sale' ? 'продажу' : 'закуп'} «${o.productName}» × ${qtyFmt(o.qty)}? Остаток будет исправлен.`)) return;
  const b = writeBatch(db);
  if (p) b.update(pRef(p.id), { stock: increment(delta), updatedAt: serverTimestamp() });
  b.delete(doc(opsCol(), o.id));
  commit(b, 'Операция отменена');
});

/* ------------------------------------------------------------------ */
/*  ПРОФИЛЬ                                                            */
/* ------------------------------------------------------------------ */
function renderProfile() {
  if (!S.profile) return;
  const isSeller = S.profile.role === 'seller';
  $('#pr-info').innerHTML = `
    <b>${esc(S.profile.name)}</b>
    <div class="muted">${isSeller ? 'Продавец' : 'Магазин'} · ${esc(S.profile.email || '')}</div>`;
  if (!isSeller) return;

  const code = S.seller?.code || '……';
  $('#pr-code').innerHTML = `
    <h3>Код для магазинов</h3>
    <div class="code">${esc(code)}</div>
    <p class="muted">Магазин вводит этот код и видит ваши товары, цены и остатки. Продажи и отчёты видны только вам.</p>
    <div class="row">
      <button type="button" class="btn ghost" id="code-new">Новый код</button>
      <button type="button" class="btn primary" id="code-share">Поделиться</button>
    </div>`;
  $('#code-share').onclick = () => shareCode(code);
  $('#code-new').onclick = newCode;

  $('#pr-viewers').innerHTML = S.viewers.length
    ? S.viewers.map((v) => `
      <li class="item">
        <div class="info"><b>${esc(v.storeName)}</b>
          <small>${v.joinedAt?.toDate ? 'с ' + v.joinedAt.toDate().toLocaleDateString('ru-RU') : ''}</small></div>
        <button type="button" class="btn sm danger" data-kick="${v.id}">Закрыть доступ</button>
      </li>`).join('')
    : '<li class="empty">Пока никто не подключился</li>';
}

$('#pr-viewers').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kick]');
  if (!b) return;
  const v = S.viewers.find((x) => x.id === b.dataset.kick);
  if (!v || !confirm(`Закрыть доступ магазину «${v.storeName}»?`)) return;
  const batch = writeBatch(db);
  batch.delete(doc(db, 'sellers', S.uid, 'viewers', v.id));
  commit(batch, 'Доступ закрыт');
});

async function shareCode(code) {
  const text = `Мой код продавца: ${code}\nОткройте ${location.origin + location.pathname}, зарегистрируйтесь как «Магазин» и введите код во вкладке «Продавцы».`;
  try {
    if (navigator.share) await navigator.share({ title: 'Код продавца', text });
    else { await navigator.clipboard.writeText(text); toast('Скопировано'); }
  } catch { /* пользователь закрыл окно */ }
}

async function newCode() {
  if (!confirm('Создать новый код? Старый перестанет работать для новых магазинов. Уже подключённые останутся.')) return;
  try {
    const code = await freeCode();
    const b = writeBatch(db);
    if (S.seller?.code) b.delete(doc(db, 'codes', S.seller.code));
    b.set(doc(db, 'codes', code), { sellerId: S.uid, sellerName: S.profile.name });
    b.update(doc(db, 'sellers', S.uid), { code });
    await b.commit();
    toast('Новый код: ' + code);
  } catch (e) { toast('Нужен интернет: ' + e.message); }
}

/* ------------------------------------------------------------------ */
/*  МАГАЗИН: продавцы и каталог                                        */
/* ------------------------------------------------------------------ */
function syncLinkSubs() {
  const ids = new Set(S.links.map((l) => l.id));
  for (const id of Object.keys(S.linkSubs)) {
    if (!ids.has(id)) { S.linkSubs[id](); delete S.linkSubs[id]; delete S.storeProducts[id]; }
  }
  for (const id of ids) {
    if (S.linkSubs[id]) continue;
    S.linkSubs[id] = onSnapshot(collection(db, 'sellers', id, 'products'), (snap) => {
      S.storeProducts[id] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderCatalog(); renderSellers();
    }, () => {
      S.storeProducts[id] = null; // продавец закрыл доступ
      renderCatalog(); renderSellers();
    });
  }
  if (S.filter !== 'all' && !ids.has(S.filter)) S.filter = 'all';
}

$('#f-join').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = String(new FormData(e.target).get('code') || '').trim().toUpperCase();
  const err = $('#join-err');
  err.textContent = '';
  try {
    const snap = await getDoc(doc(db, 'codes', code));
    if (!snap.exists()) throw new Error('Код не найден. Проверьте у продавца.');
    const { sellerId, sellerName } = snap.data();
    if (S.links.some((l) => l.id === sellerId && S.storeProducts[sellerId] !== null)) {
      throw new Error(`«${sellerName}» уже подключён`);
    }
    const b = writeBatch(db);
    b.set(doc(db, 'sellers', sellerId, 'viewers', S.uid), { code, storeName: S.profile.name, joinedAt: serverTimestamp() });
    b.set(doc(db, 'users', S.uid, 'links', sellerId), { sellerName, code, joinedAt: serverTimestamp() });
    await b.commit();
    // Если доступ ранее закрывали — переподписаться
    S.linkSubs[sellerId]?.(); delete S.linkSubs[sellerId]; syncLinkSubs();
    e.target.reset();
    toast(`Подключено: ${sellerName}`);
  } catch (ex) {
    err.textContent = ex.code === 'permission-denied' ? 'Код устарел — попросите новый у продавца' : ex.message;
  }
});

function renderSellers() {
  $('#s-list').innerHTML = S.links.length
    ? S.links.map((l) => {
      const ps = S.storeProducts[l.id];
      const st = ps === null ? '<span class="warn">доступ закрыт</span>' : ps ? `${ps.length} товаров` : 'загрузка…';
      return `<li class="item">
        <div class="info"><b>${esc(l.sellerName)}</b><small>${st} · код ${esc(l.code)}</small></div>
        <button type="button" class="btn sm" data-open="${l.id}">Товары</button>
        <button type="button" class="btn sm ghost danger" data-unlink="${l.id}" aria-label="Отключить">✕</button>
      </li>`;
    }).join('')
    : '<li class="empty">Введите код, который даст вам продавец</li>';
}

$('#s-list').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) { S.filter = open.dataset.open; renderCatalog(); show('catalog'); return; }
  const un = e.target.closest('[data-unlink]');
  if (!un) return;
  const l = S.links.find((x) => x.id === un.dataset.unlink);
  if (!l || !confirm(`Отключить продавца «${l.sellerName}»?`)) return;
  const b = writeBatch(db);
  b.delete(doc(db, 'sellers', l.id, 'viewers', S.uid));
  b.delete(doc(db, 'users', S.uid, 'links', l.id));
  commit(b, 'Отключено');
});

$('#cq').addEventListener('input', renderCatalog);
$('#c-chips').addEventListener('click', (e) => {
  const c = e.target.closest('[data-f]');
  if (c) { S.filter = c.dataset.f; renderCatalog(); }
});

function renderCatalog() {
  if (!S.links.length) {
    $('#c-chips').innerHTML = '';
    $('#c-list').innerHTML = '<li class="empty">Подключите продавца по коду во вкладке «Продавцы»</li>';
    return;
  }
  $('#c-chips').innerHTML = [['all', 'Все'], ...S.links.map((l) => [l.id, l.sellerName])]
    .map(([id, n]) => `<button type="button" class="chip ${S.filter === id ? 'on' : ''}" data-f="${id}">${esc(n)}</button>`).join('');

  const q = $('#cq').value.trim().toLowerCase();
  const rows = [];
  for (const l of S.links) {
    if (S.filter !== 'all' && S.filter !== l.id) continue;
    for (const p of S.storeProducts[l.id] || []) {
      if (q && !p.name.toLowerCase().includes(q) && !l.sellerName.toLowerCase().includes(q)) continue;
      rows.push({ ...p, seller: l.sellerName });
    }
  }
  rows.sort((a, b) => (num(b.stock) > 0) - (num(a.stock) > 0) || a.name.localeCompare(b.name, 'ru'));
  $('#c-list').innerHTML = rows.length
    ? rows.map((p) => `
      <li class="item ${num(p.stock) <= 0 ? 'out' : ''}">
        <div class="info"><b>${esc(p.name)}</b>
          <small>${esc(p.seller)} · ${num(p.stock) > 0 ? `в наличии ${qtyFmt(p.stock)}` : 'нет в наличии'}</small></div>
        <div class="price">${money(p.price)}</div>
      </li>`).join('')
    : `<li class="empty">${q ? 'Ничего не найдено' : 'У продавца пока нет товаров'}</li>`;
}

/* ------------------------------------------------------------------ */
/*  PUSH-уведомления                                                   */
/* ------------------------------------------------------------------ */
function renderPush() {
  const role = S.profile?.role;
  const what = role === 'seller'
    ? 'Сигнал, когда товар заканчивается, и итоги дня в 21:00.'
    : 'Новые товары, поступления и смена цен у ваших продавцов.';
  let st;
  if (!messaging) st = 'Этот браузер не поддерживает push. На iPhone: «Поделиться» → «На экран Домой», затем откройте приложение с иконки.';
  else if (Notification.permission === 'granted') st = 'Включены на этом устройстве.';
  else if (Notification.permission === 'denied') st = 'Заблокированы в настройках браузера для этого сайта.';
  else st = 'Выключены.';
  $('#push-state').textContent = `${st} ${what}`;
  const btn = $('#push-on');
  btn.hidden = !messaging || Notification.permission === 'denied';
  btn.textContent = Notification.permission === 'granted' ? 'Обновить подписку' : 'Включить уведомления';
}

async function registerPush(silent = false) {
  try {
    if (!messaging) throw new Error('Push не поддерживается');
    if (Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission();
      renderPush();
      if (perm !== 'granted') throw new Error('Разрешение не выдано');
    }
    const reg = await navigator.serviceWorker.ready;
    const token = await getToken(messaging, { vapidKey: self.FIREBASE_VAPID_KEY, serviceWorkerRegistration: reg });
    if (!token) throw new Error('Не удалось получить токен');
    await setDoc(doc(db, 'users', S.uid, 'tokens', token), {
      createdAt: serverTimestamp(), ua: navigator.userAgent.slice(0, 200),
    });
    if (!silent) toast('Уведомления включены');
  } catch (e) {
    if (!silent) toast(e.message);
  }
}
$('#push-on').onclick = () => registerPush(false);

if (messaging) {
  onMessage(messaging, (p) => {
    const d = p.data || {};
    toast(`${d.title || 'Уведомление'}: ${d.body || ''}`);
  });
}
