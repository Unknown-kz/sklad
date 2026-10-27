// Склад — PWA: товары, цены, остатки, продажи, закуп, доступ магазинов по коду, push.
// Сервер — Netlify Functions (/api/*), данные — Netlify Blobs.

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
const r3 = (n) => Math.round(n * 1000) / 1000;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const LOW_STOCK = 5;

const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* память переполнена */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* */ } },
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

/* ------------------------------------------------------------------ */
/*  Состояние                                                          */
/* ------------------------------------------------------------------ */
const S = {
  token: ls.get('sk_token'),
  me: null,
  // продавец
  base: [],       // товары, как их знает сервер
  products: [],   // base + ещё не отправленные операции
  viewers: [], code: '',
  outbox: ls.get('sk_outbox') || [],
  ops: [], date: ymd(), opsLoaded: false,
  // магазин
  sellers: [], filter: 'all',
  view: 'auth', started: false,
};

/* ------------------------------------------------------------------ */
/*  Сервер                                                             */
/* ------------------------------------------------------------------ */
async function api(action, body, params) {
  const qs = params ? '?' + new URLSearchParams(params) : '';
  let res;
  try {
    res = await fetch(`/api/${action}${qs}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const e = new Error('Нет интернета');
    e.offline = true;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token) { logout(true); }
  if (!res.ok) {
    const e = new Error(data.error || `Ошибка ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

/* ------------------------------------------------------------------ */
/*  Service worker, сеть, установка                                    */
/* ------------------------------------------------------------------ */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'push') {
      toast(`${e.data.title}: ${e.data.body}`);
      refresh();
    }
  });
}

const setNet = () => { $('#net').textContent = navigator.onLine ? '' : 'офлайн'; };
addEventListener('online', () => { setNet(); flush(); refresh(); });
addEventListener('offline', setNet);
setNet();

let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#install-card').hidden = false;
});
$('#install').onclick = () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  installPrompt = null;
  $('#install-card').hidden = true;
};

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
  S.view = view;
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'v-' + view));
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  $('#title').textContent = TITLES[view] || 'Склад';
  scrollTo(0, 0);
  if (view === 'report') loadOps();
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
  const busy = (on) => f.querySelectorAll('button').forEach((b) => { b.disabled = on; });
  f.oninput = upd;
  upd();
  f.onsubmit = async (e) => {
    e.preventDefault();
    busy(true);
    try { await onSubmit(values()); dlg.close(); } catch (err) { $('#dlg-err').textContent = err.message; } finally { busy(false); }
  };
  $('#dlg-cancel').onclick = () => dlg.close();
  if (extra) {
    $('#dlg-extra').onclick = async () => {
      busy(true);
      try { if (await extra.onClick()) dlg.close(); } catch (err) { $('#dlg-err').textContent = err.message; } finally { busy(false); }
    };
  }
  dlg.showModal();
  f.querySelector('input')?.focus();
}

/* ------------------------------------------------------------------ */
/*  Вход и регистрация                                                 */
/* ------------------------------------------------------------------ */
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  $$('[data-auth]').forEach((x) => x.classList.toggle('on', x.dataset.auth === mode));
  $('#f-auth').classList.toggle('register', mode === 'register');
  $('#f-auth [type=submit]').textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
  $('#auth-err').textContent = '';
}
$$('[data-auth]').forEach((b) => { b.onclick = () => setAuthMode(b.dataset.auth); });

$('#f-auth').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = e.target.querySelector('[type=submit]');
  btn.disabled = true;
  $('#auth-err').textContent = '';
  try {
    const body = { email: f.get('email'), password: f.get('password') };
    if (authMode === 'register') Object.assign(body, { name: f.get('name'), role: f.get('role') });
    const { token } = await api(authMode, body);
    S.token = token;
    ls.set('sk_token', token);
    e.target.reset();
    await boot();
  } catch (err) {
    $('#auth-err').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#logout').onclick = () => {
  const pending = S.outbox.length ? `\nВнимание: ${S.outbox.length} операций ещё не отправлены и пропадут.` : '';
  if (confirm('Выйти из аккаунта?' + pending)) logout();
};

async function logout(expired = false) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (sub && !expired) {
      await api('unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch { /* */ }
  ['sk_token', 'sk_state', 'sk_outbox'].forEach(ls.del);
  location.reload();
}

/* ------------------------------------------------------------------ */
/*  Запуск и обновление данных                                         */
/* ------------------------------------------------------------------ */
async function boot() {
  if (!S.token) { buildTabs(null); setAuthMode(authMode); show('auth'); return; }
  const cached = ls.get('sk_state');
  if (cached?.me) applyState(cached);
  await refresh();
  if (!S.me) {
    // нет ни кэша, ни связи
    $('#auth-err').textContent = 'Нет связи с сервером. Проверьте интернет и обновите страницу.';
    show('auth');
  }
}

async function refresh() {
  if (!S.token) return;
  try {
    const st = await api('state');
    ls.set('sk_state', st);
    applyState(st);
  } catch (e) {
    if (!e.offline && e.status !== 401) toast(e.message);
  }
}

function applyState(st) {
  S.me = st.me;
  if (st.me.role === 'seller') applySeller(st);
  else { S.sellers = st.sellers || []; if (S.filter !== 'all' && !S.sellers.some((x) => x.id === S.filter)) S.filter = 'all'; }
  if (!S.started) startUI();
  renderAll();
}

function applySeller(v) {
  S.base = v.products || [];
  S.viewers = v.viewers || [];
  S.code = v.code || '';
  derive();
  // кэшируем свежую версию для офлайна
  const st = ls.get('sk_state');
  if (st?.me) ls.set('sk_state', { ...st, ...v });
}

function startUI() {
  S.started = true;
  document.body.dataset.role = S.me.role;
  buildTabs(S.me.role);
  show(S.me.role === 'seller' ? 'products' : 'catalog');
  renderPush();
  if (pushSupported && Notification.permission === 'granted') registerPush(true);
  flush();
  // обновляем каждые 30 секунд, пока приложение открыто
  setInterval(() => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
    refresh();
    if (S.view === 'report') loadOps();
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { flush(); refresh(); }
  });
}

function renderAll() {
  renderProfile();
  if (S.me.role === 'seller') { renderProducts(); if (S.view === 'report') renderReport(); } else { renderSellers(); renderCatalog(); }
}

/* ------------------------------------------------------------------ */
/*  ПРОДАВЕЦ: очередь операций (продажа и закуп работают без интернета) */
/* ------------------------------------------------------------------ */
function applyOp(op, list) {
  const p = list.find((x) => x.id === op.id);
  if (!p) return;
  if (op.kind === 'sale') p.stock = r3(p.stock - op.qty);
  else { p.stock = r3(p.stock + op.qty); p.cost = op.cost; if (op.price != null) p.price = op.price; }
}

function derive() {
  S.products = structuredClone(S.base);
  S.outbox.forEach((op) => applyOp(op, S.products));
  renderProducts();
}

function queue(op) {
  S.outbox.push(op);
  ls.set('sk_outbox', S.outbox);
  derive();
  if (S.view === 'report') renderReport();
  flush();
}

let flushing = false;
async function flush() {
  if (flushing || !S.outbox.length || !S.token) return;
  flushing = true;
  let last = null;
  try {
    while (S.outbox.length) {
      const op = S.outbox[0];
      try {
        last = await api(op.kind, op);
      } catch (e) {
        if (e.offline || !e.status || e.status >= 500 || e.status === 409 || e.status === 401) break;
        toast(`Не принято (${op.name}): ${e.message}`);
      }
      S.outbox.shift();
      ls.set('sk_outbox', S.outbox);
    }
  } finally {
    flushing = false;
  }
  if (last) applySeller(last);
  else derive();
  if (S.view === 'report') loadOps();
}

/* ------------------------------------------------------------------ */
/*  ПРОДАВЕЦ: товары                                                   */
/* ------------------------------------------------------------------ */
$('#q').addEventListener('input', renderProducts);

function renderProducts() {
  if (S.me?.role !== 'seller') return;
  const q = $('#q').value.trim().toLowerCase();
  const list = S.products.filter((p) => !q || p.name.toLowerCase().includes(q));
  const value = S.products.reduce((s, p) => s + num(p.stock) * num(p.price), 0);
  const low = S.products.filter((p) => num(p.stock) <= LOW_STOCK).length;
  $('#p-stats').innerHTML = `
    <span>${S.products.length} товаров</span>
    <span>остатки на ${money(value)}</span>
    ${low ? `<span class="warn">заканчивается: ${low}</span>` : ''}
    ${S.outbox.length ? `<span class="warn">⏳ не отправлено: ${S.outbox.length}</span>` : ''}`;
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

const needNet = (e) => { throw new Error(e.offline ? 'Для этого нужен интернет' : e.message); };

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
  onSubmit: async (v) => {
    const name = v.name.trim();
    if (!name) throw new Error('Введите название');
    const res = await api('product', {
      name, price: num(v.price), stock: num(v.stock), cost: num(v.cost), date: ymd(), at: Date.now(),
    }).catch(needNet);
    applySeller(res);
    $('#q').value = '';
    renderProducts();
    toast(`Добавлено: ${name}`);
  },
});

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
      queue({ kind: 'sale', opId: uid(), id: cur.id, name: cur.name, qty, price, date: ymd(), at: Date.now() });
      toast(`Продано: ${cur.name} × ${qtyFmt(qty)} = ${money(qty * price)}`);
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
      const qty = num(v.qty);
      const cur = S.products.find((x) => x.id === p.id);
      if (!cur) throw new Error('Товар удалён');
      if (qty <= 0) throw new Error('Укажите количество');
      queue({
        kind: 'purchase', opId: uid(), id: cur.id, name: cur.name, qty,
        cost: num(v.cost), price: num(v.price), date: ymd(), at: Date.now(),
      });
      toast(`Закуп: ${cur.name} +${qtyFmt(qty)}`);
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
    onSubmit: async (v) => {
      if (S.outbox.some((o) => o.id === p.id)) throw new Error('Дождитесь отправки операций по этому товару');
      const res = await api('edit', { id: p.id, name: v.name, price: num(v.price), stock: num(v.stock) }).catch(needNet);
      applySeller(res);
      toast('Сохранено');
    },
    extra: {
      label: 'Удалить',
      onClick: async () => {
        if (!confirm(`Удалить «${p.name}»? Записи в отчётах останутся.`)) return false;
        const res = await api('remove', { id: p.id }).catch(needNet);
        applySeller(res);
        toast('Товар удалён');
        return true;
      },
    },
  });
}

/* ------------------------------------------------------------------ */
/*  ПРОДАВЕЦ: отчёт за день                                            */
/* ------------------------------------------------------------------ */
async function loadOps() {
  if (S.me?.role !== 'seller') return;
  $('#d-date').value = S.date;
  const want = S.date;
  try {
    const { ops } = await api('ops', null, { date: want });
    if (want !== S.date) return;
    S.ops = ops;
    ls.set('sk_ops_' + want, ops);
  } catch {
    S.ops = ls.get('sk_ops_' + want) || [];
  }
  renderReport();
}

function shiftDate(n) {
  const d = new Date(S.date + 'T12:00:00');
  d.setDate(d.getDate() + n);
  S.date = ymd(d);
  S.ops = [];
  renderReport();
  loadOps();
}
$('#d-prev').onclick = () => shiftDate(-1);
$('#d-next').onclick = () => shiftDate(1);
$('#d-date').onchange = (e) => { S.date = e.target.value || ymd(); loadOps(); };

function reportOps() {
  const pending = S.outbox.filter((o) => o.date === S.date).map((o) => ({
    id: o.opId, type: o.kind, productName: o.name, qty: o.qty,
    price: o.kind === 'sale' ? o.price : o.cost,
    total: Math.round(o.qty * (o.kind === 'sale' ? o.price : o.cost) * 100) / 100,
    at: o.at, pending: true,
  }));
  const sent = S.ops.filter((o) => !pending.some((x) => x.id === o.id));
  return [...pending, ...sent].sort((a, b) => b.at - a.at);
}

function renderReport() {
  const ops = reportOps();
  const sales = ops.filter((o) => o.type === 'sale');
  const buys = ops.filter((o) => o.type === 'purchase');
  const sum = (a) => a.reduce((s, o) => s + num(o.total), 0);
  const sS = sum(sales); const sB = sum(buys);

  $('#r-kpis').innerHTML = `
    <div class="kpi sale"><small>Продажи</small><b>${money(sS)}</b><small>${sales.length} опер.</small></div>
    <div class="kpi buy"><small>Закуп</small><b>${money(sB)}</b><small>${buys.length} опер.</small></div>
    <div class="kpi"><small>Разница</small><b class="${sS - sB < 0 ? 'neg' : ''}">${money(sS - sB)}</b><small>продажи − закуп</small></div>`;

  const byItem = new Map();
  for (const o of ops) {
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

  $('#r-ops').innerHTML = ops.map((o) => {
    const t = new Date(o.at);
    return `<li class="item">
      <div class="info">
        <b><span class="tag ${o.type}">${o.type === 'sale' ? 'Продажа' : 'Закуп'}</span>${esc(o.productName)}</b>
        <small>${pad(t.getHours())}:${pad(t.getMinutes())} · ${qtyFmt(o.qty)} × ${money(o.price)}${o.pending ? ' · ⏳ не отправлено' : ''}</small>
      </div>
      <div class="price">${money(o.total)}</div>
      <button type="button" class="btn sm ghost" data-cancel="${esc(o.id)}" aria-label="Отменить">✕</button>
    </li>`;
  }).join('');
}

$('#r-ops').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cancel]');
  if (!btn) return;
  const o = reportOps().find((x) => x.id === btn.dataset.cancel);
  if (!o) return;
  if (!confirm(`Отменить ${o.type === 'sale' ? 'продажу' : 'закуп'} «${o.productName}» × ${qtyFmt(o.qty)}? Остаток будет исправлен.`)) return;
  if (o.pending) {
    S.outbox = S.outbox.filter((x) => x.opId !== o.id);
    ls.set('sk_outbox', S.outbox);
    derive(); renderReport();
    toast('Операция отменена');
    return;
  }
  try {
    const res = await api('cancel', { date: S.date, opId: o.id });
    applySeller(res);
    S.ops = S.ops.filter((x) => x.id !== o.id);
    renderReport();
    toast('Операция отменена');
  } catch (err) { toast(err.offline ? 'Для отмены нужен интернет' : err.message); }
});

/* ------------------------------------------------------------------ */
/*  ПРОФИЛЬ                                                            */
/* ------------------------------------------------------------------ */
function renderProfile() {
  if (!S.me) return;
  const isSeller = S.me.role === 'seller';
  $('#pr-info').innerHTML = `
    <b>${esc(S.me.name)}</b>
    <div class="muted">${isSeller ? 'Продавец' : 'Магазин'} · ${esc(S.me.email || '')}</div>`;
  if (!isSeller) return;

  const code = S.code || '……';
  $('#pr-code').innerHTML = `
    <h3>Код для магазинов</h3>
    <div class="code">${esc(code)}</div>
    <p class="muted">Магазин вводит этот код и видит ваши товары, цены и остатки. Продажи, закуп и отчёты видны только вам.</p>
    <div class="row">
      <button type="button" class="btn ghost" id="code-new">Новый код</button>
      <button type="button" class="btn primary" id="code-share">Поделиться</button>
    </div>`;
  $('#code-share').onclick = () => shareCode(code);
  $('#code-new').onclick = newCode;

  $('#pr-viewers').innerHTML = S.viewers.length
    ? S.viewers.map((v) => `
      <li class="item">
        <div class="info"><b>${esc(v.name)}</b>
          <small>${v.joinedAt ? 'с ' + new Date(v.joinedAt).toLocaleDateString('ru-RU') : ''}</small></div>
        <button type="button" class="btn sm danger" data-kick="${esc(v.id)}">Закрыть доступ</button>
      </li>`).join('')
    : '<li class="empty">Пока никто не подключился</li>';
}

$('#pr-viewers').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-kick]');
  if (!b) return;
  const v = S.viewers.find((x) => x.id === b.dataset.kick);
  if (!v || !confirm(`Закрыть доступ магазину «${v.name}»?`)) return;
  try { applySeller(await api('kick', { storeId: v.id })); renderProfile(); toast('Доступ закрыт'); } catch (err) { toast(err.message); }
});

async function shareCode(code) {
  const text = `Мой код продавца: ${code}\nОткройте ${location.origin}, зарегистрируйтесь как «Магазин» и введите код во вкладке «Продавцы».`;
  try {
    if (navigator.share) await navigator.share({ title: 'Код продавца', text });
    else { await navigator.clipboard.writeText(text); toast('Скопировано'); }
  } catch { /* пользователь закрыл окно */ }
}

async function newCode() {
  if (!confirm('Создать новый код? Старый перестанет работать для новых магазинов. Уже подключённые останутся.')) return;
  try {
    applySeller(await api('newcode', {}));
    renderProfile();
    toast('Новый код: ' + S.code);
  } catch (e) { toast(e.offline ? 'Нужен интернет' : e.message); }
}

/* ------------------------------------------------------------------ */
/*  МАГАЗИН: продавцы и каталог                                        */
/* ------------------------------------------------------------------ */
function applyStore(st) {
  ls.set('sk_state', st);
  applyState(st);
}

$('#f-join').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = String(new FormData(e.target).get('code') || '').trim().toUpperCase();
  const err = $('#join-err');
  err.textContent = '';
  try {
    applyStore(await api('join', { code }));
    e.target.reset();
    const s = S.sellers.find((x) => x.code === code);
    toast(`Подключено: ${s?.name || code}`);
  } catch (ex) {
    err.textContent = ex.message;
  }
});

function renderSellers() {
  $('#s-list').innerHTML = S.sellers.length
    ? S.sellers.map((s) => `
      <li class="item">
        <div class="info"><b>${esc(s.name)}</b>
          <small>${s.access ? `${s.products.length} товаров` : '<span class="warn">доступ закрыт</span>'} · код ${esc(s.code)}</small></div>
        ${s.access ? `<button type="button" class="btn sm" data-open="${esc(s.id)}">Товары</button>` : ''}
        <button type="button" class="btn sm ghost danger" data-unlink="${esc(s.id)}" aria-label="Отключить">✕</button>
      </li>`).join('')
    : '<li class="empty">Введите код, который даст вам продавец</li>';
}

$('#s-list').addEventListener('click', async (e) => {
  const open = e.target.closest('[data-open]');
  if (open) { S.filter = open.dataset.open; renderCatalog(); show('catalog'); return; }
  const un = e.target.closest('[data-unlink]');
  if (!un) return;
  const s = S.sellers.find((x) => x.id === un.dataset.unlink);
  if (!s || !confirm(`Отключить продавца «${s.name}»?`)) return;
  try { applyStore(await api('unlink', { sellerId: s.id })); toast('Отключено'); } catch (err) { toast(err.message); }
});

$('#cq').addEventListener('input', renderCatalog);
$('#c-chips').addEventListener('click', (e) => {
  const c = e.target.closest('[data-f]');
  if (c) { S.filter = c.dataset.f; renderCatalog(); }
});

function renderCatalog() {
  if (S.me?.role !== 'store') return;
  if (!S.sellers.length) {
    $('#c-chips').innerHTML = '';
    $('#c-list').innerHTML = '<li class="empty">Подключите продавца по коду во вкладке «Продавцы»</li>';
    return;
  }
  $('#c-chips').innerHTML = [['all', 'Все'], ...S.sellers.filter((s) => s.access).map((s) => [s.id, s.name])]
    .map(([fid, n]) => `<button type="button" class="chip ${S.filter === fid ? 'on' : ''}" data-f="${esc(fid)}">${esc(n)}</button>`).join('');

  const q = $('#cq').value.trim().toLowerCase();
  const rows = [];
  for (const s of S.sellers) {
    if (S.filter !== 'all' && S.filter !== s.id) continue;
    for (const p of s.products) {
      if (q && !p.name.toLowerCase().includes(q) && !s.name.toLowerCase().includes(q)) continue;
      rows.push({ ...p, seller: s.name });
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
/*  PUSH-уведомления (стандартный Web Push)                            */
/* ------------------------------------------------------------------ */
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function renderPush() {
  const what = S.me?.role === 'seller'
    ? 'Сигнал, когда товар заканчивается, и итоги дня в 21:00.'
    : 'Новые товары, поступления и смена цен у ваших продавцов.';
  let st;
  if (!pushSupported) st = 'Этот браузер не поддерживает push. На iPhone: «Поделиться» → «На экран Домой», затем откройте приложение с иконки.';
  else if (Notification.permission === 'granted') st = 'Включены на этом устройстве.';
  else if (Notification.permission === 'denied') st = 'Заблокированы в настройках браузера для этого сайта.';
  else st = 'Выключены.';
  $('#push-state').textContent = `${st} ${what}`;
  const btn = $('#push-on');
  btn.hidden = !pushSupported || Notification.permission === 'denied';
  btn.textContent = Notification.permission === 'granted' ? 'Обновить подписку' : 'Включить уведомления';
}

function b64ToBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function registerPush(silent = false) {
  try {
    if (!pushSupported) throw new Error('Push не поддерживается');
    if (Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission();
      renderPush();
      if (perm !== 'granted') throw new Error('Разрешение не выдано');
    }
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api('vapid');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    }
    await api('subscribe', { subscription: sub.toJSON() });
    if (!silent) toast('Уведомления включены');
  } catch (e) {
    if (!silent) toast(e.message);
  }
}
$('#push-on').onclick = () => registerPush(false);

/* ------------------------------------------------------------------ */
boot();
