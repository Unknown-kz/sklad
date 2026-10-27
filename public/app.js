// Склад — PWA: товары, цены, остатки, продажи, закуп, доступ по коду, push.
// Без регистрации: имя + название магазина (или код). Сервер — Netlify Functions (/api/*).

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
const cleanCode = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
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
  // мой магазин (null — пока не открыт)
  shop: null,
  base: [],       // товары, как их знает сервер
  products: [],   // base + ещё не отправленные операции
  viewers: [], code: '',
  outbox: ls.get('sk_outbox') || [],
  ops: [], date: ymd(),
  // магазины, к которым я подключён
  joined: [], filter: 'all',
  view: 'start', started: false, tabsKey: '',
};

// Ссылка вида https://сайт/?join=K7M2QX — сразу подставляет код
const linkCode = cleanCode(new URLSearchParams(location.search).get('join')).slice(0, 6);
if (linkCode) history.replaceState(null, '', location.pathname);

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
function titleFor(view) {
  return {
    start: 'Склад',
    products: S.shop?.name || 'Мой магазин',
    report: 'Продажи и закуп за день',
    catalog: 'Магазины',
    profile: 'Профиль',
  }[view] || 'Склад';
}

function show(view) {
  S.view = view;
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'v-' + view));
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  $('#title').textContent = titleFor(view);
  scrollTo(0, 0);
  if (view === 'report') loadOps();
}

function buildTabs() {
  const tabs = S.shop
    ? [['products', '📦', 'Мой магазин'], ['report', '📊', 'Отчёт'], ['catalog', '🏪', 'Магазины'], ['profile', '👤', 'Профиль']]
    : [['catalog', '🏪', 'Магазины'], ['profile', '👤', 'Профиль']];
  const key = tabs.map((t) => t[0]).join();
  if (key === S.tabsKey) return;
  S.tabsKey = key;
  $('#tabs').hidden = false;
  $('#tabs').innerHTML = tabs.map(([v, i, l]) => `<button type="button" data-view="${v}"><span>${i}</span>${l}</button>`).join('');
  if (S.started && !tabs.some((t) => t[0] === S.view)) show(tabs[0][0]);
  else $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
}
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) show(b.dataset.view);
});

/* ------------------------------------------------------------------ */
/*  Диалог-форма                                                       */
/* ------------------------------------------------------------------ */
function form({ title, text, fields, submit = 'Сохранить', hint, onSubmit, extra }) {
  const dlg = $('#dlg');
  const f = $('#dlg-form');
  f.innerHTML = `
    <h2>${esc(title)}</h2>
    ${text ? `<p class="muted">${esc(text)}</p>` : ''}
    ${fields.map((fl) => `
      <label>${esc(fl.label)}
        <input name="${fl.name}" type="${fl.type || 'text'}"
          ${fl.type === 'number' ? 'inputmode="decimal" step="any"' : ''}
          ${fl.required ? 'required' : ''} ${fl.min != null ? `min="${fl.min}"` : ''}
          ${fl.maxlength ? `maxlength="${fl.maxlength}"` : ''} class="${fl.cls || ''}"
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
/*  Первый экран: открыть магазин / присоединиться / войти по ключу    */
/* ------------------------------------------------------------------ */
let startMode = 'open';
function setStartMode(mode) {
  startMode = mode;
  $$('[data-mode]').forEach((x) => x.classList.toggle('on', x.dataset.mode === mode));
  const f = $('#f-start');
  f.classList.toggle('join', mode === 'join');
  f.shopName.required = mode === 'open';
  f.code.required = mode === 'join';
  f.querySelector('[type=submit]').textContent = mode === 'open' ? 'Открыть магазин' : 'Присоединиться';
  $('#start-err').textContent = '';
}
$$('[data-mode]').forEach((b) => { b.onclick = () => setStartMode(b.dataset.mode); });

$('#f-start').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('[type=submit]');
  btn.disabled = true;
  $('#start-err').textContent = '';
  try {
    const body = { name: f.name.value };
    if (startMode === 'open') body.shopName = f.shopName.value; else body.code = f.code.value;
    const res = await api('start', body);
    signedIn(res);
    if (startMode === 'open') toast(`Магазин открыт! Ваш код: ${res.shop.code}`);
    else toast('Подключено');
  } catch (err) {
    $('#start-err').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#restore-open').onclick = () => form({
  title: 'Вход по ключу',
  text: 'Ключ из 8 символов есть в Профиле на старом телефоне.',
  submit: 'Войти',
  fields: [{ name: 'key', label: 'Ключ восстановления', required: true, maxlength: 9, cls: 'code-input', placeholder: 'ABCD-EFGH' }],
  onSubmit: async (v) => { signedIn(await api('restore', { key: v.key })); toast('С возвращением!'); },
});

function signedIn(res) {
  S.token = res.token;
  ls.set('sk_token', res.token);
  const { token, ...st } = res;
  ls.set('sk_state', st);
  applyState(st);
}

$('#logout').onclick = () => {
  const pending = S.outbox.length ? `\n\nВнимание: ${S.outbox.length} операций ещё не отправлены и пропадут.` : '';
  const key = S.me?.restoreKey ? `\n\nЧтобы вернуться, понадобится ключ: ${fmtKey(S.me.restoreKey)}` : '';
  if (confirm('Выйти с этого телефона?' + key + pending)) logout();
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
  Object.keys(localStorage).filter((k) => k.startsWith('sk_')).forEach(ls.del);
  location.reload();
}

/* ------------------------------------------------------------------ */
/*  Запуск и обновление данных                                         */
/* ------------------------------------------------------------------ */
async function boot() {
  if (!S.token) {
    if (linkCode) { setStartMode('join'); $('#f-start').code.value = linkCode; }
    else setStartMode('open');
    show('start');
    return;
  }
  const cached = ls.get('sk_state');
  if (cached?.me) applyState(cached);
  await refresh();
  if (!S.me) {
    $('#start-err').textContent = 'Нет связи с сервером. Проверьте интернет и обновите страницу.';
    show('start');
    return;
  }
  if (linkCode) offerJoin(linkCode);
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
  S.shop = st.shop || null;
  if (S.shop) applySeller(S.shop);
  S.joined = st.joined || [];
  if (S.filter !== 'all' && !S.joined.some((x) => x.id === S.filter && x.access)) S.filter = 'all';
  buildTabs();
  if (!S.started) startUI();
  renderAll();
}

function applySeller(v) {
  S.shop = { ...S.shop, ...v };
  S.base = v.products || [];
  S.viewers = v.viewers || [];
  S.code = v.code || '';
  derive();
  // кэшируем свежую версию для офлайна
  const st = ls.get('sk_state');
  if (st?.me) ls.set('sk_state', { ...st, shop: { ...(st.shop || {}), ...v } });
}

function startUI() {
  S.started = true;
  show(S.shop ? 'products' : 'catalog');
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
  $('#title').textContent = titleFor(S.view);
  renderProfile();
  renderCatalog();
  if (S.shop) { renderProducts(); if (S.view === 'report') renderReport(); }
}

/* ------------------------------------------------------------------ */
/*  МОЙ МАГАЗИН: очередь операций (продажа и закуп работают без интернета) */
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
/*  МОЙ МАГАЗИН: товары                                                   */
/* ------------------------------------------------------------------ */
$('#q').addEventListener('input', renderProducts);

function renderProducts() {
  if (!S.shop) return;
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
/*  МОЙ МАГАЗИН: отчёт за день                                            */
/* ------------------------------------------------------------------ */
async function loadOps() {
  if (!S.shop) return;
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
const fmtKey = (k) => (k ? `${k.slice(0, 4)}-${k.slice(4)}` : '');
const joinLink = (code) => `${location.origin}${location.pathname}?join=${code}`;
const shareText = (name, code) => `Магазин «${name}»: смотрите товары, цены и остатки.\nКод для подключения: ${code}`;

function renderProfile() {
  if (!S.me) return;

  // мой магазин
  if (S.shop) {
    const code = S.code || '……';
    const text = shareText(S.shop.name, code);
    const link = joinLink(code);
    $('#pr-shop').innerHTML = `
      <h3>${esc(S.shop.name)}</h3>
      <p class="muted">Владелец: ${esc(S.me.name)}. Дайте этот код тем, кто должен видеть ваши товары, цены и остатки.</p>
      <div class="code">${esc(code)}</div>
      <div class="share">
        <a class="btn wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`${text}\n${link}`)}">WhatsApp</a>
        <a class="btn tg" target="_blank" rel="noopener" href="https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}">Telegram</a>
        <button type="button" class="btn" id="code-share">${navigator.share ? 'Ещё…' : 'Копировать'}</button>
      </div>
      <p class="muted">Продажи, закуп, отчёты и цены закупа видите только вы.</p>
      <button type="button" class="btn ghost sm" id="code-new">Сменить код</button>`;
    $('#code-share').onclick = () => shareCode(text, link);
    $('#code-new').onclick = newCode;
  } else {
    $('#pr-shop').innerHTML = `
      <h3>Свой магазин</h3>
      <p class="muted">Откройте свой магазин: добавляйте товары, отмечайте продажи и закуп, давайте код другим.</p>
      <button type="button" class="btn primary" id="shop-open">Открыть свой магазин</button>`;
    $('#shop-open').onclick = openShopDialog;
  }

  // кто подключился ко мне
  $('#pr-viewers-card').hidden = !S.shop;
  $('#pr-viewers').innerHTML = S.viewers.length
    ? S.viewers.map((v) => `
      <li class="item">
        <div class="info"><b>${esc(v.name)}</b>
          <small>${v.joinedAt ? 'с ' + new Date(v.joinedAt).toLocaleDateString('ru-RU') : ''}</small></div>
        <button type="button" class="btn sm danger" data-kick="${esc(v.id)}">Закрыть доступ</button>
      </li>`).join('')
    : '<li class="empty">Пока никто не подключился</li>';

  // куда подключён я
  $('#pr-joined').innerHTML = S.joined.length
    ? S.joined.map((s) => `
      <li class="item">
        <div class="info"><b>${esc(s.name)}</b>
          <small>${s.access ? `${s.products.length} товаров` : '<span class="warn">доступ закрыт</span>'}${s.owner ? ' · ' + esc(s.owner) : ''}</small></div>
        <button type="button" class="btn sm ghost danger" data-unlink="${esc(s.id)}">Отключиться</button>
      </li>`).join('')
    : '<li class="empty">Пока нет. Введите код во вкладке «Магазины».</li>';

  // ключ для входа на другом телефоне
  $('#pr-key').innerHTML = `
    <h3>${esc(S.me.name)}</h3>
    <p class="muted">Ключ, чтобы войти на другом телефоне или после переустановки. Никому его не давайте и сохраните себе.</p>
    <div class="key" id="key-box">••••-••••</div>
    <div class="row"><button type="button" class="btn sm" id="key-show">Показать</button><button type="button" class="btn sm" id="key-copy">Копировать</button></div>`;
  $('#key-show').onclick = () => { $('#key-box').textContent = fmtKey(S.me.restoreKey); };
  $('#key-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(fmtKey(S.me.restoreKey)); toast('Ключ скопирован'); } catch { $('#key-box').textContent = fmtKey(S.me.restoreKey); }
  };
}

function openShopDialog() {
  form({
    title: 'Открыть свой магазин',
    submit: 'Открыть',
    fields: [{ name: 'shopName', label: 'Название магазина', required: true, maxlength: 60 }],
    onSubmit: async (v) => {
      const st = await api('open', { shopName: v.shopName }).catch(needNet);
      ls.set('sk_state', st);
      applyState(st);
      show('products');
      toast(`Магазин открыт! Ваш код: ${S.code}`);
    },
  });
}

$('#pr-viewers').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-kick]');
  if (!b) return;
  const v = S.viewers.find((x) => x.id === b.dataset.kick);
  if (!v || !confirm(`Закрыть доступ для «${v.name}»?`)) return;
  try { applySeller(await api('kick', { storeId: v.id })); renderProfile(); toast('Доступ закрыт'); } catch (err) { toast(err.message); }
});

$('#pr-joined').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-unlink]');
  if (!b) return;
  const s = S.joined.find((x) => x.id === b.dataset.unlink);
  if (!s || !confirm(`Отключиться от «${s.name}»?`)) return;
  try { applyJoined(await api('unlink', { sellerId: s.id })); toast('Отключено'); } catch (err) { toast(err.message); }
});

async function shareCode(text, link) {
  try {
    if (navigator.share) await navigator.share({ title: 'Код магазина', text, url: link });
    else { await navigator.clipboard.writeText(`${text}\n${link}`); toast('Скопировано — вставьте в любой чат'); }
  } catch { /* пользователь закрыл окно */ }
}

async function newCode() {
  if (!confirm('Сменить код? Старый перестанет работать для новых людей. Уже подключённые останутся.')) return;
  try {
    applySeller(await api('newcode', {}));
    renderProfile();
    toast('Новый код: ' + S.code);
  } catch (e) { toast(e.offline ? 'Нужен интернет' : e.message); }
}

/* ------------------------------------------------------------------ */
/*  МАГАЗИНЫ, к которым я подключён                                    */
/* ------------------------------------------------------------------ */
function applyJoined(st) {
  ls.set('sk_state', st);
  applyState(st);
}

async function joinByCode(raw) {
  const st = await api('join', { code: raw });
  applyJoined(st);
  const s = S.joined.find((x) => x.code === cleanCode(raw));
  if (s) S.filter = s.id;
  show('catalog');
  renderCatalog();
  toast(`Подключено: ${s?.name || cleanCode(raw)}`);
}

function offerJoin(code) {
  if (S.code === code || S.joined.some((x) => x.code === code && x.access)) return;
  if (confirm(`Подключиться к магазину по коду ${code}?`)) {
    joinByCode(code).catch((e) => toast(e.message));
  }
}

$('#f-join').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#join-err');
  err.textContent = '';
  const btn = e.target.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    await joinByCode(e.target.code.value);
    e.target.reset();
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});

$('#cq').addEventListener('input', renderCatalog);
$('#c-chips').addEventListener('click', (e) => {
  const c = e.target.closest('[data-f]');
  if (c) { S.filter = c.dataset.f; renderCatalog(); }
});

function renderCatalog() {
  if (!S.me) return;
  const open = S.joined.filter((s) => s.access);
  $('#c-body').hidden = !S.joined.length;
  if (!S.joined.length) return;
  $('#c-chips').innerHTML = [['all', 'Все'], ...open.map((s) => [s.id, s.name])]
    .map(([fid, n]) => `<button type="button" class="chip ${S.filter === fid ? 'on' : ''}" data-f="${esc(fid)}">${esc(n)}</button>`).join('');

  const q = $('#cq').value.trim().toLowerCase();
  const rows = [];
  for (const s of open) {
    if (S.filter !== 'all' && S.filter !== s.id) continue;
    for (const p of s.products) {
      if (q && !p.name.toLowerCase().includes(q) && !s.name.toLowerCase().includes(q)) continue;
      rows.push({ ...p, shop: s.name });
    }
  }
  rows.sort((a, b) => (num(b.stock) > 0) - (num(a.stock) > 0) || a.name.localeCompare(b.name, 'ru'));
  const closed = S.joined.filter((s) => !s.access).map((s) => esc(s.name)).join(', ');
  $('#c-list').innerHTML = (rows.length
    ? rows.map((p) => `
      <li class="item ${num(p.stock) <= 0 ? 'out' : ''}">
        <div class="info"><b>${esc(p.name)}</b>
          <small>${esc(p.shop)} · ${num(p.stock) > 0 ? `в наличии ${qtyFmt(p.stock)}` : 'нет в наличии'}</small></div>
        <div class="price">${money(p.price)}</div>
      </li>`).join('')
    : `<li class="empty">${q ? 'Ничего не найдено' : 'В магазине пока нет товаров'}</li>`)
    + (closed ? `<li class="empty">Доступ закрыт: ${closed}</li>` : '');
}

/* ------------------------------------------------------------------ */
/*  PUSH-уведомления (стандартный Web Push)                            */
/* ------------------------------------------------------------------ */
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function renderPush() {
  const what = [
    S.shop ? 'когда ваш товар заканчивается и итоги дня в 21:00' : '',
    'новые товары, поступления и смена цен в магазинах, к которым вы подключены',
  ].filter(Boolean).join('; ');
  let st;
  if (!pushSupported) st = 'Этот браузер не поддерживает push. На iPhone: «Поделиться» → «На экран Домой», затем откройте приложение с иконки.';
  else if (Notification.permission === 'granted') st = 'Включены на этом телефоне.';
  else if (Notification.permission === 'denied') st = 'Заблокированы в настройках браузера для этого сайта.';
  else st = 'Выключены.';
  $('#push-state').textContent = `${st} Приходят: ${what}.`;
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
    renderPush();
    if (!silent) toast('Уведомления включены');
  } catch (e) {
    if (!silent) toast(e.message);
  }
}
$('#push-on').onclick = () => registerPush(false);

/* ------------------------------------------------------------------ */
boot();
