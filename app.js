'use strict';

/* =====================================================================
   Лиды CRM — локальная CRM для прозвона лидов из парсера (Яндекс Карты)
   Данные хранятся в IndexedDB браузера. Резервная копия — JSON-файл.
   ===================================================================== */

const STATUSES = [
  { key: 'new',        label: 'Новый',            color: '#8a94a6' },
  { key: 'no_answer',  label: 'Не дозвонился',    color: '#f59e0b' },
  { key: 'callback',   label: 'Перезвонить',      color: '#3b82f6' },
  { key: 'interested', label: 'Интерес',          color: '#10b981' },
  { key: 'proposal',   label: 'КП / встреча',     color: '#a855f7' },
  { key: 'client',     label: 'Клиент',           color: '#16a34a' },
  { key: 'refused',    label: 'Отказ',            color: '#ef4444' },
  { key: 'bad',        label: 'Не наш / не тот номер', color: '#64748b' },
];
const ST = Object.fromEntries(STATUSES.map((s, i) => [s.key, { ...s, hotkey: i + 1 }]));
const POSITIVE = ['interested', 'proposal', 'client'];
const PAGE_SIZE = 50;

// Поля, которые берутся из файла и обновляются при повторной загрузке
const DATA_FIELDS = ['name', 'category', 'categories', 'address', 'city', 'region', 'rating', 'ratingsCount',
  'reviewsCount', 'phones', 'sites', 'socials', 'hours', 'coords', 'email', 'mapLinks', 'query', 'raw'];

/* ---------------------------- утилиты ---------------------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const DAY = 864e5;

function normPhone(s) {
  let d = String(s).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return d.length >= 11 && d.length <= 13 ? d : '';
}
function fmtPhone(d) {
  if (d.length === 11 && d[0] === '7') return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
  return '+' + d;
}
function extractPhones(v) {
  const out = [];
  for (const m of String(v ?? '').match(/\+?\d[\d\s\-()]{8,}\d/g) || []) {
    const p = normPhone(m);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}
function extractLinks(v) {
  return [...new Set(String(v ?? '').split(/[\s,;]+/).map(x => x.trim())
    .filter(x => /^https?:\/\//i.test(x) || /^(www\.)?[\w-]+\.[a-zа-я]{2,}(\/|$)/i.test(x)))];
}
function extractEmails(v) { return [...new Set(String(v ?? '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [])]; }
function toNum(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(',', '.').replace(/\s/g, ''));
  return Number.isFinite(n) ? n : null;
}
const href = u => /^https?:\/\//i.test(u) ? u : 'http://' + u;
function linkLabel(u) {
  const h = u.toLowerCase();
  if (/wa\.me|whatsapp/.test(h)) return 'WhatsApp';
  if (/t\.me|telegram/.test(h)) return 'Telegram';
  if (/vk\.(com|ru)|vkontakte/.test(h)) return 'VK';
  if (/ok\.ru/.test(h)) return 'OK';
  if (/youtu/.test(h)) return 'YouTube';
  if (/rutube/.test(h)) return 'Rutube';
  if (/instagram/.test(h)) return 'Instagram';
  if (/viber/.test(h)) return 'Viber';
  if (/dzen\.ru|zen\.yandex/.test(h)) return 'Дзен';
  if (/yandex\.[a-z]+\/maps|ya\.ru\/maps/.test(h)) return 'Яндекс Карты';
  try { return new URL(href(u)).hostname.replace(/^www\./, ''); } catch { return u; }
}
function parseQuery(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (/^[\[{]/.test(s)) {
    const pick = x => Array.isArray(x) ? [...new Set(x.map(pick).filter(Boolean))].join(', ')
      : (x && typeof x === 'object') ? String(x.text || x.query || x.name || '') : String(x ?? '');
    try { return pick(JSON.parse(s)).trim(); } catch {
      const m = s.match(/"text"\s*:\s*"([^"]+)"/);
      return m ? m[1] : s;
    }
  }
  return s;
}
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const endOfToday = () => startOfDay(Date.now()) + DAY - 1;
const hm = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function fmtDT(t) {
  if (!t) return '';
  const d = new Date(t);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)} ${hm(t)}`;
}
function fmtWhen(t) {
  if (!t) return '';
  const dd = Math.round((startOfDay(t) - startOfDay(Date.now())) / DAY);
  if (dd === 0) return 'сегодня ' + hm(t);
  if (dd === 1) return 'завтра ' + hm(t);
  if (dd === -1) return 'вчера ' + hm(t);
  return fmtDT(t);
}
function fmtAgo(t) {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return m + ' мин назад';
  return fmtWhen(t);
}
const toLocalInput = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hm(t)}`; };
const dateStamp = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`; };
function defaultCallback() { const d = new Date(Date.now() + DAY); d.setHours(10, 0, 0, 0); return d.getTime(); }
function plural(n, a, b, c) { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; }
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 2800);
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
// Номер в виде, который понимает любая набиралка: +79676701771
const dialPhone = d => '+' + d;

// Копирует строго чистый текст (без HTML), чтобы через синхронизацию буфера на телефон приходил ровно номер
async function copyText(s) {
  s = String(s).trim();
  let ok = false;
  try { await navigator.clipboard.writeText(s); ok = true; } catch { /* fallback ниже */ }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  toast(ok ? 'Скопировано: ' + s : 'Не удалось скопировать', ok ? '' : 'err');
}

// QR-код с tel:-ссылкой — навёл камеру телефона, и номер открылся в набиралке
function qrSvg(phone) {
  if (typeof qrcode === 'undefined') return '';
  const q = qrcode(0, 'M');
  q.addData('tel:' + dialPhone(phone));
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
function qrBlockHtml(l, phone) {
  if (!phone || typeof qrcode === 'undefined') return '';
  return `<div class="qr-box"><div class="qr">${qrSvg(phone)}</div>
    <div class="qr-cap">Наведи камеру телефона — откроется набор<br><b>${fmtPhone(phone)}</b></div></div>`;
}
const ls = {
  get(k, def) { try { const v = localStorage.getItem('lids.' + k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem('lids.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

/* ---------------------------- IndexedDB ---------------------------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('lids-crm', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('leads', { keyPath: 'id' });
        r.result.createObjectStore('imports', { keyPath: 'id' });
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  all(store) {
    return new Promise((res, rej) => {
      const r = this.db.transaction(store).objectStore(store).getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  write(store, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, 'readwrite');
      fn(t.objectStore(store));
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  },
  putMany(store, items) { return this.write(store, os => items.forEach(i => os.put(i))); },
  delMany(store, ids) { return this.write(store, os => ids.forEach(id => os.delete(id))); },
  clear(store) { return this.write(store, os => os.clear()); },
};

/* ---------------------------- состояние ---------------------------- */
const state = {
  leads: new Map(),
  imports: [],
  phoneIndex: new Map(),   // телефон -> Set(id)
  view: 'base',
  f: Object.assign({ q: '', niche: '', city: '', site: '', callback: '', importId: '', statuses: [], sort: 'imported', dir: -1, page: 1 },
    ls.get('filters', {}), { page: 1, q: '' }),
  filtered: [],
  selected: new Set(),
  drawerId: null,
  call: Object.assign({ niche: '', city: '', site: '', statuses: ['new', 'no_answer', 'callback'], dueOnly: true, autoNext: true, samePhone: false },
    ls.get('call', {}), { queue: [], idx: 0, built: false }),
};
const searchCache = new Map();

function saveLeads(list) {
  list.forEach(l => searchCache.delete(l.id));
  DB.putMany('leads', list).catch(e => toast('Ошибка сохранения: ' + e.message, 'err'));
}
function rebuildPhoneIndex() {
  state.phoneIndex.clear();
  for (const l of state.leads.values()) for (const p of l.phones) {
    if (!state.phoneIndex.has(p)) state.phoneIndex.set(p, new Set());
    state.phoneIndex.get(p).add(l.id);
  }
}
function phoneTwins(l) {
  const ids = new Set();
  for (const p of l.phones) for (const id of state.phoneIndex.get(p) || []) if (id !== l.id) ids.add(id);
  return [...ids].map(id => state.leads.get(id)).filter(Boolean);
}
const niches = () => [...new Set([...state.leads.values()].map(l => l.niche).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
const cities = () => [...new Set([...state.leads.values()].map(l => l.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
const lastNote = l => { for (let i = (l.history || []).length - 1; i >= 0; i--) if (l.history[i].n) return l.history[i].n; return ''; };
const isDue = l => l.status === 'callback' && l.callbackAt && l.callbackAt <= endOfToday();

/* ------------------------- смена статуса ------------------------- */
function setStatus(lead, status, { note = '', callbackAt = null } = {}) {
  const now = Date.now();
  lead.status = status;
  lead.callbackAt = status === 'callback' ? (callbackAt || lead.callbackAt || defaultCallback()) : null;
  lead.history = lead.history || [];
  lead.history.push({ t: now, s: status, n: note.trim() });
  if (status !== 'new') {
    lead.lastCallAt = now;
    lead.attempts = (lead.attempts || 0) + 1;
  }
  lead.updatedAt = now;
}
function applyStatus(lead, status, opts = {}) {
  setStatus(lead, status, opts);
  const changed = [lead];
  if (opts.withTwins) for (const t of phoneTwins(lead)) {
    setStatus(t, status, { note: `по номеру из «${lead.name}»${opts.note ? ': ' + opts.note : ''}`, callbackAt: lead.callbackAt });
    changed.push(t);
  }
  saveLeads(changed);
  if (changed.length > 1) toast(`Статус «${ST[status].label}» поставлен ещё ${changed.length - 1} ${plural(changed.length - 1, 'карточке', 'карточкам', 'карточкам')} с тем же номером`);
  refreshAfterChange();
}
function refreshAfterChange() {
  updateCallbackBadge();
  if (state.view === 'base') renderBase();
  if (state.view === 'stats') renderStats();
  if (state.drawerId) renderDrawer();
}

/* =========================== ИМПОРТ =========================== */
const FIELD_RULES = [
  ['id',           h => /^id\b|^id орг|^идентиф/.test(h)],
  ['query',        h => h.startsWith('текущий запрос') || h === 'запрос' || h === 'поисковый запрос'],
  ['allQueries',   h => h.startsWith('все запрос')],
  ['name',         h => h.startsWith('название') || h.startsWith('наименование') || h === 'компания' || h === 'организация'],
  ['category',     h => h.startsWith('основная катег') || h.startsWith('рубрика')],
  ['categories',   h => h.startsWith('категори') || h.startsWith('рубрики')],
  ['address',      h => h.startsWith('адрес')],
  ['city',         h => h.startsWith('город') || h === 'населенный пункт'],
  ['region',       h => h.startsWith('регион') || h.startsWith('область')],
  ['rating',       h => h.startsWith('рейтинг')],
  ['ratingsCount', h => h.startsWith('оценок') || h.startsWith('кол-во оценок') || h.startsWith('количество оценок')],
  ['reviewsCount', h => h.startsWith('отзывов') || h.startsWith('кол-во отзыв') || h.startsWith('количество отзыв')],
  ['phones',       h => h.startsWith('контакт') || h.includes('телефон')],
  ['sites',        h => h.startsWith('сайт') || h === 'website'],
  ['socials',      h => h.startsWith('соцсет') || h.startsWith('социальн')],
  ['hours',        h => h.startsWith('режим') || h.startsWith('часы работ') || h.startsWith('время работ')],
  ['coords',       h => h.startsWith('координ')],
  ['email',        h => h.startsWith('email') || h.startsWith('e-mail') || h.startsWith('почта') || h.startsWith('эл. почта')],
];
const FIELD_NAMES = {
  id: 'ID организации', name: 'Название', phones: 'Телефоны', query: 'Поисковый запрос', category: 'Основная категория',
  address: 'Адрес', city: 'Город', rating: 'Рейтинг', reviewsCount: 'Отзывов', sites: 'Сайты', socials: 'Соцсети',
  hours: 'Режим работы', email: 'Email', mapLinks: 'Ссылки на карты',
};

function detectColumns(headers) {
  const map = { mapLinks: [] };
  headers.forEach((raw, i) => {
    const h = raw.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!h) return;
    if (h.startsWith('ссылка')) { map.mapLinks.push(i); return; }
    for (const [field, test] of FIELD_RULES) {
      if (map[field] == null && test(h)) { map[field] = i; return; }
    }
  });
  return map;
}

function rowToLead(row, map, headers) {
  const g = f => map[f] == null ? '' : row[map[f]];
  const str = f => String(g(f) ?? '').trim();
  const contacts = g('phones');
  const name = str('name');
  const address = str('address');
  const idRaw = str('id');
  const rating = toNum(g('rating'));
  const raw = {};
  headers.forEach((h, i) => { const v = row[i]; if (h && v !== '' && v != null) raw[h] = typeof v === 'number' ? v : String(v); });
  return {
    id: idRaw ? 'y' + idRaw.replace(/\.0+$/, '') : 'h' + hash((name + '|' + address + '|' + contacts).toLowerCase()),
    name, address,
    query: parseQuery(g('query')) || parseQuery(g('allQueries')),
    category: str('category'),
    categories: str('categories'),
    city: str('city'),
    region: str('region'),
    rating: rating == null ? null : Math.round(rating * 10) / 10,
    ratingsCount: toNum(g('ratingsCount')),
    reviewsCount: toNum(g('reviewsCount')),
    phones: extractPhones(contacts),
    sites: extractLinks(g('sites')),
    socials: extractLinks(g('socials')),
    hours: str('hours'),
    coords: str('coords'),
    email: [...new Set([...extractEmails(g('email')), ...extractEmails(contacts)])].join(', '),
    mapLinks: map.mapLinks.flatMap(i => extractLinks(row[i])),
    raw,
  };
}

async function parseFile(file) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  let rows = [];
  for (const name of wb.SheetNames) {
    const r = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: true, blankrows: false });
    if (r.length > rows.length) rows = r;
  }
  const hi = rows.findIndex(r => r.filter(c => String(c).trim()).length >= 3);
  if (hi < 0) return { headers: [], map: {}, leads: [] };
  const headers = rows[hi].map(h => String(h).trim());
  const map = detectColumns(headers);
  const leads = rows.slice(hi + 1)
    .filter(r => r.some(c => String(c).trim()))
    .map(r => rowToLead(r, map, headers))
    .filter(l => l.name || l.phones.length);
  return { headers, map, leads };
}

async function handleFiles(files) {
  for (const file of files) {
    try {
      const parsed = await parseFile(file);
      if (!parsed.leads.length) { toast(`В файле «${file.name}» не найдено ни одной компании`, 'err'); continue; }
      await showImportDialog(file.name, parsed);
    } catch (e) {
      console.error(e);
      toast(`Не удалось прочитать «${file.name}»: ${e.message}`, 'err');
    }
  }
}

function showImportDialog(fileName, parsed) {
  return new Promise(resolve => {
    const { leads, map, headers } = parsed;
    const unique = new Map(leads.map(l => [l.id, l]));
    const existing = [...unique.keys()].filter(id => state.leads.has(id)).length;
    const withPhone = [...unique.values()].filter(l => l.phones.length).length;
    const qCount = {};
    for (const l of unique.values()) { const k = l.query || l.category; if (k) qCount[k] = (qCount[k] || 0) + 1; }
    const topQ = Object.entries(qCount).sort((a, b) => b[1] - a[1]);
    const mapRows = Object.entries(FIELD_NAMES).map(([f, label]) => {
      const col = f === 'mapLinks' ? (map.mapLinks.length ? map.mapLinks.map(i => headers[i]).join(', ') : null) : (map[f] != null ? headers[map[f]] : null);
      return `<div>${label}</div><div class="${col ? '' : 'miss'}">${col ? '«' + esc(col) + '»' : 'не найдено'}</div>`;
    }).join('');

    openModal(`
      <h2>Импорт: ${esc(fileName)}</h2>
      <div class="nums">
        <div><b>${unique.size}</b><span>компаний в файле</span></div>
        <div><b>${unique.size - existing}</b><span>новых</span></div>
        <div><b>${existing}</b><span>уже есть в базе (обновятся, статусы сохранятся)</span></div>
        <div><b>${withPhone}</b><span>с телефоном</span></div>
      </div>
      <div class="sect"><div class="lbl">Ниша для этих лидов</div>
        <input id="impNiche" list="nicheList" style="width:100%" value="${esc(topQ[0]?.[0] || '')}" placeholder="Например: Ювелирные магазины">
        ${topQ.length ? `<div class="qchips">${topQ.slice(0, 12).map(([q, n]) => `<button data-q="${esc(q)}">${esc(q)} · ${n}</button>`).join('')}</div>` : ''}
        <label class="radio"><input type="radio" name="impMode" value="fixed" checked><span>Всем лидам из файла — эта ниша</span></label>
        <label class="radio"><input type="radio" name="impMode" value="query"><span>Брать нишу из столбца «Текущий запрос» у каждой строки (если пусто — эта ниша)</span></label>
        <div class="muted" style="font-size:12.5px">У лидов, которые уже есть в базе, ниша не меняется.</div>
      </div>
      <details class="sect"><summary class="muted" style="cursor:pointer">Какие столбцы распознаны</summary>
        <div class="map-table" style="margin-top:8px">${mapRows}</div>
      </details>
      <div class="actions">
        <button class="btn ghost" data-act="cancel">Отмена</button>
        <button class="btn primary" data-act="ok">Импортировать ${unique.size}</button>
      </div>`);

    const box = $('#modalBox');
    box.onclick = async e => {
      const q = e.target.closest('[data-q]');
      if (q) { $('#impNiche').value = q.dataset.q; return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') { closeModal(); resolve(false); }
      if (act === 'ok') {
        const niche = $('#impNiche').value.trim();
        const mode = $('input[name=impMode]:checked').value;
        closeModal();
        await doImport(fileName, [...unique.values()], mode, niche);
        resolve(true);
      }
    };
  });
}

async function doImport(fileName, leads, mode, nicheValue) {
  const now = Date.now();
  const impId = 'imp' + now.toString(36);
  let added = 0, updated = 0;
  const changed = [];
  for (const l of leads) {
    const niche = mode === 'query' ? (l.query || nicheValue || l.category) : (nicheValue || l.query || l.category);
    const ex = state.leads.get(l.id);
    if (ex) {
      for (const k of DATA_FIELDS) ex[k] = l[k];
      if (!ex.niche) ex.niche = niche;
      ex.imports = [...new Set([...(ex.imports || []), impId])];
      changed.push(ex);
      updated++;
    } else {
      const nl = { ...l, niche, status: 'new', history: [], note: '', attempts: 0, callbackAt: null, lastCallAt: null,
        importedAt: now, updatedAt: now, imports: [impId], source: fileName };
      state.leads.set(nl.id, nl);
      changed.push(nl);
      added++;
    }
  }
  const imp = { id: impId, file: fileName, at: now, niche: mode === 'query' ? 'из запроса' : nicheValue, rows: leads.length, added, updated };
  state.imports.push(imp);
  changed.forEach(l => searchCache.delete(l.id));
  await DB.putMany('leads', changed);
  await DB.putMany('imports', [imp]);
  rebuildPhoneIndex();
  toast(`Загружено: ${added} новых, ${updated} обновлено`, 'ok');
  renderAll();
}

/* =========================== БАЗА =========================== */
function searchText(l) {
  let s = searchCache.get(l.id);
  if (!s) {
    s = [l.name, l.address, l.category, l.categories, l.niche, l.city, l.note, l.email, l.query, ...(l.sites || []),
      ...(l.history || []).map(h => h.n)].join(' ').toLowerCase();
    searchCache.set(l.id, s);
  }
  return s;
}
function leadMatches(l, f, skipStatus) {
  if (f.niche && l.niche !== f.niche) return false;
  if (f.city && l.city !== f.city) return false;
  if (f.importId && !(l.imports || []).includes(f.importId)) return false;
  if (f.site === 'yes' && !l.sites.length) return false;
  if (f.site === 'no' && l.sites.length) return false;
  if (f.callback === 'due' && !isDue(l)) return false;
  if (f.callback === 'overdue' && !(l.status === 'callback' && l.callbackAt < Date.now())) return false;
  if (!skipStatus && f.statuses.length && !f.statuses.includes(l.status)) return false;
  if (f.q) {
    const q = f.q.toLowerCase().trim();
    const digits = q.replace(/[\s+()-]/g, '');
    if (/^\d{3,}$/.test(digits)) {
      const alt = digits[0] === '8' ? '7' + digits.slice(1) : digits;
      if (!l.phones.some(p => p.includes(digits) || p.includes(alt))) return false;
    } else if (!q.split(/\s+/).every(w => searchText(l).includes(w))) return false;
  }
  return true;
}
const SORTS = {
  imported: l => l.importedAt || 0,
  name: l => (l.name || '').toLowerCase(),
  niche: l => (l.niche || '').toLowerCase(),
  rating: l => l.rating ?? -1,
  status: l => STATUSES.findIndex(s => s.key === l.status),
  last: l => l.status === 'callback' ? -(l.callbackAt || 0) : (l.lastCallAt || 0) - 1e13,
};

function fillSelect(sel, items, allLabel, value) {
  sel.innerHTML = `<option value="">${allLabel}</option>` + items.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
  sel.value = items.some(([v]) => v === value) ? value : '';
}
function renderFilterOptions() {
  const f = state.f;
  const ns = niches(), cs = cities();
  fillSelect($('#fNiche'), ns.map(n => [n, n]), 'Все ниши', f.niche);
  fillSelect($('#fCity'), cs.map(c => [c, c]), 'Все города', f.city);
  fillSelect($('#fImport'), [...state.imports].reverse().map(i => [i.id, `${i.file} · ${fmtDT(i.at)}`]), 'Все загрузки', f.importId);
  f.niche = $('#fNiche').value; f.city = $('#fCity').value; f.importId = $('#fImport').value;
  $('#fSite').value = f.site; $('#fCallback').value = f.callback;
  $('#nicheList').innerHTML = ns.map(n => `<option value="${esc(n)}">`).join('');
  fillSelect($('#qNiche'), ns.map(n => [n, n]), 'Все ниши', state.call.niche);
  fillSelect($('#qCity'), cs.map(c => [c, c]), 'Все города', state.call.city);
}

function renderBase() {
  const f = state.f;
  ls.set('filters', { ...f, q: '', page: 1 });
  const pre = [...state.leads.values()].filter(l => leadMatches(l, f, true));
  const counts = {};
  pre.forEach(l => { counts[l.status] = (counts[l.status] || 0) + 1; });
  $('#statusChips').innerHTML =
    `<span class="chip ${f.statuses.length ? '' : 'on'}" data-st="">Все <b>${pre.length}</b></span>` +
    STATUSES.map(s => `<span class="chip ${f.statuses.includes(s.key) ? 'on' : ''}" style="--c:${s.color}" data-st="${s.key}"><i class="dot"></i>${s.label} <b>${counts[s.key] || 0}</b></span>`).join('');

  const list = f.statuses.length ? pre.filter(l => f.statuses.includes(l.status)) : pre;
  const key = SORTS[f.sort] || SORTS.imported;
  list.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * f.dir || (a.name || '').localeCompare(b.name || '', 'ru'); });
  state.filtered = list;

  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  f.page = Math.min(f.page, pages);
  const slice = list.slice((f.page - 1) * PAGE_SIZE, f.page * PAGE_SIZE);
  const now = Date.now();

  $('#leadRows').innerHTML = slice.map(l => {
    const s = ST[l.status] || ST.new;
    const ph = l.phones.slice(0, 2).map(p => `<a href="tel:+${p}">${fmtPhone(p)}</a>`).join('') +
      (l.phones.length > 2 ? `<span class="more">ещё ${l.phones.length - 2}</span>` : '') + (l.phones.length ? '' : '<span class="no">—</span>');
    const when = l.status === 'callback' && l.callbackAt
      ? `<div class="cb ${l.callbackAt < now ? 'over' : ''}">↻ ${fmtWhen(l.callbackAt)}</div>` : '';
    return `<tr data-id="${esc(l.id)}" class="${state.selected.has(l.id) ? 'sel' : ''} ${isDue(l) ? 'due' : ''}">
      <td class="c-sel"><input type="checkbox" class="rsel" ${state.selected.has(l.id) ? 'checked' : ''}></td>
      <td class="c-name"><div class="nm">${esc(l.name || 'Без названия')}</div><div class="sub" title="${esc(l.address)}">${esc([l.category, l.address].filter(Boolean).join(' · '))}</div></td>
      <td><span class="niche-tag" title="${esc(l.niche)}">${esc(l.niche || '—')}</span></td>
      <td class="c-phones">${ph}</td>
      <td style="white-space:nowrap">${l.rating != null ? '★ ' + l.rating : '—'}<div class="sub">${l.reviewsCount != null ? l.reviewsCount + ' отз.' : ''}</div></td>
      <td>${l.sites.length ? '<span class="yes">есть</span>' : '<span class="no">нет</span>'}</td>
      <td><select class="st" style="--c:${s.color}">${STATUSES.map(x => `<option value="${x.key}" ${x.key === l.status ? 'selected' : ''}>${x.label}</option>`).join('')}</select></td>
      <td class="c-when">${when}${l.lastCallAt ? `<div class="sub">${fmtAgo(l.lastCallAt)}${l.attempts > 1 ? ' · ' + l.attempts + ' попыт.' : ''}</div>` : ''}</td>
      <td class="c-note"><div>${esc(l.note || lastNote(l))}</div></td>
    </tr>`;
  }).join('');

  const empty = $('#baseEmpty');
  if (!state.leads.size) {
    empty.innerHTML = `<h3>База пока пустая</h3><p>Нажми «Загрузить Excel» сверху и выбери файл из парсера.<br>Можно выбрать сразу несколько файлов.</p>`;
  } else if (!list.length) {
    empty.innerHTML = `<h3>Ничего не найдено</h3><p>Попробуй изменить фильтры.</p>`;
  }
  empty.classList.toggle('hidden', list.length > 0);
  $('table.leads').classList.toggle('hidden', list.length === 0);

  $$('.leads th[data-sort]').forEach(th => {
    th.querySelector('.arrow')?.remove();
    if (th.dataset.sort === f.sort) th.insertAdjacentHTML('beforeend', `<span class="arrow"> ${f.dir > 0 ? '↑' : '↓'}</span>`);
  });
  $('#selPage').checked = slice.length > 0 && slice.every(l => state.selected.has(l.id));

  let pg = `<span>${list.length} ${plural(list.length, 'компания', 'компании', 'компаний')}</span><span class="sp"></span>`;
  if (pages > 1) {
    const btn = (p, t = p) => `<button class="btn small ${p === f.page ? 'cur' : ''}" data-page="${p}">${t}</button>`;
    pg += f.page > 1 ? btn(f.page - 1, '←') : '';
    const set = new Set([1, pages, f.page - 2, f.page - 1, f.page, f.page + 1, f.page + 2].filter(p => p >= 1 && p <= pages));
    let prev = 0;
    [...set].sort((a, b) => a - b).forEach(p => { if (p - prev > 1) pg += '<span>…</span>'; pg += btn(p); prev = p; });
    pg += f.page < pages ? btn(f.page + 1, '→') : '';
  }
  $('#pager').innerHTML = pg;
  renderBulkbar();
}

function renderBulkbar() {
  const n = state.selected.size;
  $('#bulkbar').classList.toggle('hidden', n === 0);
  $('#selCount').textContent = n;
  const all = state.filtered.length;
  const b = $('#selAllFiltered');
  b.textContent = `Выбрать все ${all} по фильтру`;
  b.classList.toggle('hidden', n >= all);
}

/* =========================== КАРТОЧКА (drawer) =========================== */
function linksHtml(l) {
  const a = (u, label, cls = '') => `<a class="link-chip ${cls}" href="${esc(href(u))}" target="_blank" rel="noopener">${esc(label)}</a>`;
  const parts = [
    // ссылок на карты бывает несколько колонок (карточка, отзывы) — одинаковые схлопываем
    ...[...new Set(l.mapLinks || [])].map(u => a(u, /review|otzyv/i.test(u) ? 'Отзывы на картах' : 'Яндекс Карты', 'map')),
    ...l.sites.map(u => a(u, '🌐 ' + linkLabel(u))),
    ...l.socials.map(u => a(u, linkLabel(u))),
  ];
  return parts.join('') || '<span class="muted">нет</span>';
}
function twinsHtml(l) {
  const tw = phoneTwins(l);
  if (!tw.length) return '';
  return `<div class="warn-box">Этот номер есть ещё у ${tw.length} ${plural(tw.length, 'карточки', 'карточек', 'карточек')} (сеть / общий номер):
    <ul>${tw.slice(0, 6).map(t => `<li data-open="${esc(t.id)}">${esc(t.name)} — ${esc(t.address || '')} · <span class="badge" style="--c:${ST[t.status].color}">${ST[t.status].label}</span></li>`).join('')}
    ${tw.length > 6 ? `<li>…и ещё ${tw.length - 6}</li>` : ''}</ul></div>`;
}
function historyHtml(l) {
  const h = [...(l.history || [])].reverse();
  if (!h.length) return '<div class="muted">Звонков ещё не было</div>';
  return `<ul class="history">${h.map(x => `<li><span class="t">${fmtDT(x.t)}</span><div><span class="badge" style="--c:${ST[x.s]?.color}">${ST[x.s]?.label || x.s}</span>${x.n ? `<div class="n">${esc(x.n)}</div>` : ''}</div></li>`).join('')}</ul>`;
}
function callbackRowHtml(l) {
  if (l.status !== 'callback') return '';
  return `<div class="cb-row">Перезвонить:
    <input type="datetime-local" class="cb-input" value="${l.callbackAt ? toLocalInput(l.callbackAt) : ''}">
    <button class="btn small" data-cb="1h">через час</button>
    <button class="btn small" data-cb="today17">сегодня 17:00</button>
    <button class="btn small" data-cb="tom10">завтра 10:00</button>
    <button class="btn small" data-cb="3d">через 3 дня</button>
    <button class="btn small" data-cb="7d">через неделю</button>
  </div>`;
}
function quickCallback(kind) {
  const d = new Date();
  if (kind === '1h') return Date.now() + 3600e3;
  if (kind === 'today17') { d.setHours(17, 0, 0, 0); return d.getTime(); }
  const days = { tom10: 1, '3d': 3, '7d': 7 }[kind];
  d.setDate(d.getDate() + days); d.setHours(10, 0, 0, 0);
  return d.getTime();
}
function setCallbackTime(l, t) {
  if (!t || isNaN(t)) return;
  l.callbackAt = t;
  l.updatedAt = Date.now();
  saveLeads([l]);
  toast('Перезвон: ' + fmtWhen(t));
  refreshAfterChange();
  if (state.view === 'call') renderCallCard();
}

function openDrawer(id) {
  state.drawerId = id;
  renderDrawer();
  $('#drawer').classList.add('open');
  $('#drawerBack').classList.add('open');
}
function closeDrawer() {
  state.drawerId = null;
  $('#drawer').classList.remove('open');
  $('#drawerBack').classList.remove('open');
}
function renderDrawer() {
  const l = state.leads.get(state.drawerId);
  if (!l) return closeDrawer();
  const s = ST[l.status];
  const raw = Object.entries(l.raw || {});
  $('#drawer').innerHTML = `
    <button class="btn ghost close" data-act="close">✕</button>
    <h2>${esc(l.name || 'Без названия')}</h2>
    <div class="muted">${esc([l.category, l.city].filter(Boolean).join(' · '))}</div>
    <div style="margin-top:8px"><span class="badge" style="--c:${s.color}">${s.label}</span>
      ${l.attempts ? `<span class="muted" style="font-size:13px;margin-left:8px">${l.attempts} ${plural(l.attempts, 'звонок', 'звонка', 'звонков')}, последний ${fmtAgo(l.lastCallAt)}</span>` : ''}</div>

    <div class="sect"><div class="lbl">Телефоны</div>
      ${l.phones.map(p => `<div class="phone-row"><a href="tel:+${p}">${fmtPhone(p)}</a><button class="btn small ghost" data-copy="+${p}">копировать</button><button class="btn small ghost" data-qr="${p}">QR на телефон</button></div>`).join('') || '<div class="muted">Телефонов нет</div>'}
      <div id="dQr"></div>
      ${twinsHtml(l)}
    </div>

    <div class="sect"><div class="lbl">Статус</div>
      <div class="status-grid">${STATUSES.map(x => `<button class="st-btn ${x.key === l.status ? 'on' : ''}" style="--c:${x.color}" data-status="${x.key}">${x.label}</button>`).join('')}</div>
      <input id="dNote" placeholder="Комментарий к звонку (попадёт в историю вместе со статусом)" style="width:100%;margin-top:8px">
      ${callbackRowHtml(l)}
    </div>

    <div class="sect"><div class="lbl">Постоянная заметка</div>
      <textarea id="dPersist" rows="3" placeholder="ЛПР, имя, что важно знать…">${esc(l.note || '')}</textarea>
    </div>

    <div class="sect"><div class="lbl">Ниша</div>
      <input id="dNiche" list="nicheList" value="${esc(l.niche || '')}" style="width:100%">
    </div>

    <div class="sect"><div class="lbl">Ссылки</div><div class="links">${linksHtml(l)}</div></div>

    <div class="sect"><div class="lbl">О компании</div>
      <div class="kv">
        <div>Адрес</div><div>${esc(l.address || '—')}</div>
        <div>Рейтинг</div><div>${l.rating != null ? '★ ' + l.rating : '—'} ${l.ratingsCount != null ? `· ${l.ratingsCount} оценок` : ''} ${l.reviewsCount != null ? `· ${l.reviewsCount} отзывов` : ''}</div>
        <div>Режим работы</div><div>${esc(l.hours || '—')}</div>
        <div>Email</div><div>${l.email ? esc(l.email) : '—'}</div>
        <div>Категории</div><div>${esc(l.categories || l.category || '—')}</div>
        <div>Запрос</div><div>${esc(l.query || '—')}</div>
        <div>Источник</div><div>${esc(l.source || '—')} · ${fmtDT(l.importedAt)}</div>
      </div>
    </div>

    <div class="sect"><div class="lbl">История</div>${historyHtml(l)}</div>

    ${raw.length ? `<details class="sect raw"><summary class="muted" style="cursor:pointer">Все данные из файла</summary>
      <div class="kv" style="margin-top:8px">${raw.map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`).join('')}</div></details>` : ''}

    <div class="sect"><button class="btn small danger" data-act="delete">Удалить карточку</button></div>`;
}

function onDrawerClick(e) {
  const l = state.leads.get(state.drawerId);
  if (!l) return;
  const t = e.target;
  if (t.closest('[data-act=close]')) return closeDrawer();
  const cp = t.closest('[data-copy]');
  if (cp) return copyText(cp.dataset.copy);
  const qr = t.closest('[data-qr]');
  if (qr) {
    const box = $('#dQr');
    const same = box.dataset.p === qr.dataset.qr;
    box.innerHTML = same ? '' : qrBlockHtml(l, qr.dataset.qr);
    box.dataset.p = same ? '' : qr.dataset.qr;
    return;
  }
  const op = t.closest('[data-open]');
  if (op) return openDrawer(op.dataset.open);
  const st = t.closest('[data-status]');
  if (st) return applyStatus(l, st.dataset.status, { note: $('#dNote').value });
  const cb = t.closest('[data-cb]');
  if (cb) return setCallbackTime(l, quickCallback(cb.dataset.cb));
  if (t.closest('[data-act=delete]')) {
    if (!confirm(`Удалить «${l.name}» из базы?`)) return;
    deleteLeads([l.id]);
    closeDrawer();
  }
}
function onDrawerChange(e) {
  const l = state.leads.get(state.drawerId);
  if (!l) return;
  if (e.target.id === 'dPersist') { l.note = e.target.value; l.updatedAt = Date.now(); saveLeads([l]); refreshList(); }
  if (e.target.id === 'dNiche') { l.niche = e.target.value.trim(); saveLeads([l]); renderFilterOptions(); refreshList(); }
  if (e.target.classList.contains('cb-input')) setCallbackTime(l, new Date(e.target.value).getTime());
}
function refreshList() { if (state.view === 'base') renderBase(); }

async function deleteLeads(ids) {
  ids.forEach(id => { state.leads.delete(id); state.selected.delete(id); searchCache.delete(id); });
  await DB.delMany('leads', ids);
  rebuildPhoneIndex();
  toast(`Удалено: ${ids.length}`);
  renderAll();
}

/* =========================== ПРОЗВОН =========================== */
function renderCallSetup() {
  const c = state.call;
  $('#qStatuses').innerHTML = STATUSES.map(s => `<label class="check" style="margin:0"><input type="checkbox" value="${s.key}" ${c.statuses.includes(s.key) ? 'checked' : ''}><span class="badge" style="--c:${s.color}">${s.label}</span></label>`).join('');
  $('#qSite').value = c.site;
  $('#qDueOnly').checked = c.dueOnly;
  $('#qAutoNext').checked = c.autoNext;
  $('#qSamePhone').checked = c.samePhone;
  updateQueueInfo();
}
function readCallSetup() {
  const c = state.call;
  c.niche = $('#qNiche').value;
  c.city = $('#qCity').value;
  c.site = $('#qSite').value;
  c.statuses = $$('#qStatuses input:checked').map(i => i.value);
  c.dueOnly = $('#qDueOnly').checked;
  c.autoNext = $('#qAutoNext').checked;
  c.samePhone = $('#qSamePhone').checked;
  const { queue, idx, built, ...persist } = c;
  ls.set('call', persist);
}
function queueCandidates() {
  const c = state.call, now = Date.now();
  const order = { callback: 0, new: 1, no_answer: 2 };
  return [...state.leads.values()]
    .filter(l => l.phones.length && c.statuses.includes(l.status)
      && (!c.niche || l.niche === c.niche) && (!c.city || l.city === c.city)
      && (c.site !== 'yes' || l.sites.length) && (c.site !== 'no' || !l.sites.length)
      && !(l.status === 'callback' && c.dueOnly && (l.callbackAt || 0) > now))
    .sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3)
      || (a.status === 'callback' ? (a.callbackAt || 0) - (b.callbackAt || 0) : 0)
      || (a.lastCallAt || 0) - (b.lastCallAt || 0)
      || (b.reviewsCount || 0) - (a.reviewsCount || 0));
}
function updateQueueInfo() {
  const c = state.call;
  const n = queueCandidates().length;
  $('#qInfo').innerHTML = c.built
    ? `В очереди: <b>${c.queue.length}</b> · пройдено <b>${Math.min(c.idx, c.queue.length)}</b><br>По текущим настройкам доступно: ${n}`
    : `По этим настройкам: <b>${n}</b> ${plural(n, 'карточка', 'карточки', 'карточек')} с телефоном`;
}
function buildQueue() {
  readCallSetup();
  state.call.queue = queueCandidates().map(l => l.id);
  state.call.idx = 0;
  state.call.built = true;
  renderCallCard();
  updateQueueInfo();
  if (!state.call.queue.length) toast('Под эти условия нет ни одной карточки');
}
function currentCallLead() {
  const c = state.call;
  while (c.idx < c.queue.length && !state.leads.has(c.queue[c.idx])) c.queue.splice(c.idx, 1);
  return state.leads.get(c.queue[c.idx]);
}
function renderCallCard() {
  const c = state.call;
  const box = $('#callCard');
  if (!c.built) {
    box.innerHTML = `<div class="cc-done"><h2>Режим прозвона</h2>
      <p class="muted">Слева выбери нишу, город и статусы — и нажми «Собрать очередь».<br>
      Карточки будут идти по одной: сначала перезвоны, срок которых наступил, потом новые, потом недозвоны.</p>
      <button class="btn primary" data-act="build">Собрать очередь</button></div>`;
    return;
  }
  const l = currentCallLead();
  if (!l) {
    const done = c.queue.map(id => state.leads.get(id)).filter(Boolean);
    const cnt = {};
    done.forEach(x => { cnt[x.status] = (cnt[x.status] || 0) + 1; });
    box.innerHTML = `<div class="cc-done"><h2>${c.queue.length ? 'Очередь пройдена 🎉' : 'Очередь пустая'}</h2>
      ${c.queue.length ? `<div class="legend" style="justify-content:center;margin:14px 0">${STATUSES.filter(s => cnt[s.key]).map(s => `<span><i style="background:${s.color}"></i>${s.label}: ${cnt[s.key]}</span>`).join('')}</div>` : ''}
      <p class="muted">Можно собрать новую очередь с другими настройками.</p>
      <button class="btn primary" data-act="build">Собрать заново</button>
      ${c.queue.length ? '<button class="btn" data-act="prev">← Вернуться к последней</button>' : ''}</div>`;
    updateQueueInfo();
    return;
  }
  const s = ST[l.status];
  const pct = c.queue.length ? (c.idx / c.queue.length) * 100 : 0;
  const qrPhone = l.phones.includes(c.qrPhone) ? c.qrPhone : l.phones[0];
  box.innerHTML = `
    <div class="cc-top">
      <span class="muted">Карточка <b>${c.idx + 1}</b> из ${c.queue.length}</span>
      <span class="sp"></span>
      <button class="btn small" data-act="prev" ${c.idx === 0 ? 'disabled' : ''}>← Назад</button>
      <button class="btn small" data-act="next">Пропустить →</button>
      <button class="btn small ghost" data-act="open">Открыть карточку</button>
    </div>
    <div class="progress"><div style="width:${pct}%"></div></div>

    <h2>${esc(l.name || 'Без названия')}</h2>
    <div class="cc-meta">
      <span>${esc(l.category || '')}</span>
      ${l.niche ? `<span class="niche-tag">${esc(l.niche)}</span>` : ''}
      ${l.rating != null ? `<span>★ ${l.rating}${l.reviewsCount != null ? ` · ${l.reviewsCount} отзывов` : ''}</span>` : ''}
    </div>
    <div class="cc-meta"><span>📍 ${esc([l.address, l.city].filter(Boolean).join(', ') || '—')}</span>${l.hours ? `<span>🕘 ${esc(l.hours)}</span>` : ''}</div>

    <div class="cc-phone-wrap">
      <div class="cc-phones">${l.phones.map(p => `<div class="cc-phone ${p === qrPhone ? 'on' : ''}"><a href="tel:+${p}">${fmtPhone(p)}</a>
        <button class="btn small ghost" data-copy="+${p}" title="Скопировать +${p}">⧉</button>
        ${l.phones.length > 1 ? `<button class="btn small ghost" data-qr="${p}" title="Показать QR этого номера">QR</button>` : ''}</div>`).join('')}</div>
      ${qrBlockHtml(l, qrPhone)}
    </div>
    ${twinsHtml(l)}

    <div class="sect"><div class="links">${linksHtml(l)}</div></div>

    <div class="sect">
      <div class="lbl">Сейчас: <span class="badge" style="--c:${s.color}">${s.label}</span>
        ${l.attempts ? `<span style="text-transform:none;font-weight:400"> · ${l.attempts} ${plural(l.attempts, 'звонок', 'звонка', 'звонков')}, последний ${fmtAgo(l.lastCallAt)}</span>` : ''}
        ${l.status === 'callback' && l.callbackAt ? `<span style="text-transform:none;font-weight:400"> · перезвон ${fmtWhen(l.callbackAt)}</span>` : ''}
      </div>
      <textarea id="ccNote" rows="2" placeholder="Итог звонка: кто ответил, что сказали… (сохранится в историю вместе со статусом)"></textarea>
      <div class="status-grid" style="margin-top:8px">${STATUSES.map(x => `<button class="st-btn ${x.key === l.status ? 'on' : ''}" style="--c:${x.color}" data-status="${x.key}"><kbd>${ST[x.key].hotkey}</kbd>${x.label}</button>`).join('')}</div>
      ${callbackRowHtml(l)}
    </div>

    <div class="cc-cols">
      <div class="sect"><div class="lbl">Постоянная заметка</div>
        <textarea id="ccPersist" rows="3" placeholder="ЛПР, имя, что важно знать…">${esc(l.note || '')}</textarea></div>
      <div class="sect"><div class="lbl">История</div>${historyHtml(l)}</div>
    </div>`;
  updateQueueInfo();
}
function callNext() { const c = state.call; if (c.idx < c.queue.length) c.idx++; renderCallCard(); }
function callPrev() { const c = state.call; if (c.idx > 0) c.idx--; renderCallCard(); }
function callSetStatus(status) {
  const l = currentCallLead();
  if (!l) return;
  const note = $('#ccNote')?.value || '';
  applyStatus(l, status, { note, withTwins: state.call.samePhone });
  toast(`${l.name}: ${ST[status].label}`);
  if (state.call.autoNext && status !== 'callback') callNext();
  else renderCallCard();
}
function onCallClick(e) {
  const t = e.target;
  const act = t.closest('[data-act]')?.dataset.act;
  if (act === 'build') return buildQueue();
  if (act === 'next') return callNext();
  if (act === 'prev') return callPrev();
  const l = currentCallLead();
  if (act === 'open' && l) return openDrawer(l.id);
  const cp = t.closest('[data-copy]');
  if (cp) return copyText(cp.dataset.copy);
  const qr = t.closest('[data-qr]');
  if (qr) { state.call.qrPhone = qr.dataset.qr; return renderCallCard(); }
  const op = t.closest('[data-open]');
  if (op) return openDrawer(op.dataset.open);
  const st = t.closest('[data-status]');
  if (st) return callSetStatus(st.dataset.status);
  const cb = t.closest('[data-cb]');
  if (cb && l) return setCallbackTime(l, quickCallback(cb.dataset.cb));
}
function onCallChange(e) {
  const l = currentCallLead();
  if (!l) return;
  if (e.target.id === 'ccPersist') { l.note = e.target.value; l.updatedAt = Date.now(); saveLeads([l]); }
  if (e.target.classList.contains('cb-input')) setCallbackTime(l, new Date(e.target.value).getTime());
}

/* =========================== СТАТИСТИКА =========================== */
function renderStats() {
  const leads = [...state.leads.values()];
  const total = leads.length;
  const processed = leads.filter(l => l.status !== 'new').length;
  const today = startOfDay(Date.now());
  const days = 14;
  const perDay = Array(days).fill(0);
  let callsToday = 0, calls7 = 0;
  for (const l of leads) for (const h of l.history || []) {
    if (h.s === 'new') continue;
    const d = Math.floor((startOfDay(h.t) - today) / DAY) + days - 1;
    if (d >= 0 && d < days) perDay[d]++;
    if (h.t >= today) callsToday++;
    if (h.t >= today - 6 * DAY) calls7++;
  }
  const cnt = {};
  leads.forEach(l => { cnt[l.status] = (cnt[l.status] || 0) + 1; });
  const positive = POSITIVE.reduce((a, k) => a + (cnt[k] || 0), 0);
  const overdue = leads.filter(l => l.status === 'callback' && l.callbackAt < Date.now()).length;
  const max = Math.max(1, ...perDay);

  const byNiche = {};
  for (const l of leads) {
    const n = l.niche || 'Без ниши';
    const r = byNiche[n] || (byNiche[n] = { total: 0, processed: 0, s: {} });
    r.total++;
    if (l.status !== 'new') r.processed++;
    r.s[l.status] = (r.s[l.status] || 0) + 1;
  }
  const nicheRows = Object.entries(byNiche).sort((a, b) => b[1].total - a[1].total).map(([n, r]) => {
    const pos = POSITIVE.reduce((a, k) => a + (r.s[k] || 0), 0);
    const pct = Math.round(r.processed / r.total * 100);
    return `<tr class="click" data-niche="${esc(n === 'Без ниши' ? '' : n)}">
      <td>${esc(n)}</td><td class="num">${r.total}</td>
      <td><div style="display:flex;align-items:center;gap:8px"><div class="mini-bar" style="flex:1"><div style="width:${pct}%"></div></div><span class="muted" style="font-size:12px;width:34px">${pct}%</span></div></td>
      <td class="num">${r.s.no_answer || 0}</td><td class="num">${r.s.callback || 0}</td>
      <td class="num">${pos}</td><td class="num">${r.s.client || 0}</td><td class="num">${r.s.refused || 0}</td>
      <td class="num">${r.processed ? Math.round(pos / r.processed * 100) + '%' : '—'}</td></tr>`;
  }).join('');

  const dayLabel = i => { const d = new Date(today - (days - 1 - i) * DAY); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`; };

  $('#statsBody').innerHTML = !total ? `<div class="empty panel"><h3>Статистики пока нет</h3><p>Загрузи файл и начни прозвон.</p></div>` : `
    <div class="cards">
      <div class="panel card"><div class="v">${total}</div><div class="l">лидов в базе</div></div>
      <div class="panel card"><div class="v">${processed} <span class="muted" style="font-size:16px">${Math.round(processed / total * 100)}%</span></div><div class="l">обработано</div></div>
      <div class="panel card"><div class="v">${callsToday}</div><div class="l">звонков сегодня</div></div>
      <div class="panel card"><div class="v">${calls7}</div><div class="l">звонков за 7 дней</div></div>
      <div class="panel card"><div class="v" style="color:var(--ok)">${positive}</div><div class="l">интерес / КП / клиенты</div></div>
      <div class="panel card"><div class="v" style="color:${overdue ? 'var(--warn)' : 'inherit'}">${overdue}</div><div class="l">просроченных перезвонов</div></div>
    </div>
    <div class="stats-grid">
      <div class="panel"><h3>Звонки за 14 дней</h3>
        <div class="bars">${perDay.map((v, i) => `<div class="b"><span class="v">${v || ''}</span><i style="height:${v / max * 120}px"></i><span>${dayLabel(i)}</span></div>`).join('')}</div>
      </div>
      <div class="panel"><h3>Воронка по статусам</h3>
        <div class="stack">${STATUSES.filter(s => cnt[s.key]).map(s => `<div title="${s.label}: ${cnt[s.key]}" style="width:${cnt[s.key] / total * 100}%;background:${s.color}"></div>`).join('')}</div>
        <div class="legend">${STATUSES.map(s => `<span><i style="background:${s.color}"></i>${s.label}: <b>${cnt[s.key] || 0}</b></span>`).join('')}</div>
      </div>
    </div>
    <div class="panel" style="padding:16px;margin-top:16px;overflow-x:auto"><h3 style="margin:0 0 12px;font-size:15px">По нишам <span class="muted" style="font-weight:400;font-size:13px">— клик откроет нишу в базе</span></h3>
      <table class="simple"><thead><tr><th>Ниша</th><th class="num">Всего</th><th>Обработано</th><th class="num">Недозвон</th><th class="num">Перезвон</th><th class="num">Интерес+</th><th class="num">Клиенты</th><th class="num">Отказ</th><th class="num">Конверсия</th></tr></thead>
      <tbody>${nicheRows}</tbody></table>
      <div class="muted" style="font-size:12px;margin-top:8px">Конверсия = (интерес + КП + клиенты) / обработанные.</div>
    </div>`;
}

/* =========================== ИМПОРТЫ =========================== */
function renderImports() {
  const list = [...state.imports].sort((a, b) => b.at - a.at);
  $('#importsBody').innerHTML = !list.length ? `<div class="empty panel"><h3>Загрузок ещё не было</h3><p>Нажми «Загрузить Excel».</p></div>` : `
    <div class="panel" style="padding:16px;overflow-x:auto"><table class="simple">
      <thead><tr><th>Файл</th><th>Когда</th><th>Ниша</th><th class="num">Строк</th><th class="num">Новых</th><th class="num">Обновлено</th><th></th></tr></thead>
      <tbody>${list.map(i => `<tr>
        <td>${esc(i.file)}</td><td>${fmtDT(i.at)}</td><td>${esc(i.niche || '—')}</td>
        <td class="num">${i.rows}</td><td class="num">${i.added}</td><td class="num">${i.updated}</td>
        <td style="white-space:nowrap;text-align:right">
          <button class="btn small" data-imp-show="${i.id}">Показать в базе</button>
          <button class="btn small danger" data-imp-del="${i.id}" title="Удалит карточки из этой загрузки, которые ещё не прозвонены">Удалить необработанные</button>
        </td></tr>`).join('')}</tbody></table></div>`;
}
async function deleteImport(id) {
  const imp = state.imports.find(i => i.id === id);
  const toDelete = [], toUpdate = [];
  for (const l of state.leads.values()) {
    if (!(l.imports || []).includes(id)) continue;
    if (l.status === 'new' && l.imports.length === 1) toDelete.push(l.id);
    else { l.imports = l.imports.filter(x => x !== id); toUpdate.push(l); }
  }
  if (!confirm(`Удалить ${toDelete.length} необработанных карточек из «${imp.file}»?\nПрозвоненные (${toUpdate.length}) останутся в базе.`)) return;
  state.imports = state.imports.filter(i => i.id !== id);
  await DB.delMany('imports', [id]);
  saveLeads(toUpdate);
  if (state.f.importId === id) state.f.importId = '';
  await deleteLeads(toDelete);
}

/* =========================== ЭКСПОРТ / БЭКАП =========================== */
function exportXlsx() {
  const list = state.filtered.length ? state.filtered : [...state.leads.values()];
  if (!list.length) return toast('Нечего экспортировать', 'err');
  const rows = list.map(l => ({
    'Название': l.name, 'Ниша': l.niche, 'Статус': ST[l.status]?.label,
    'Перезвонить': l.status === 'callback' ? fmtDT(l.callbackAt) : '',
    // чистый текст без скобок и пробелов — нормально копируется и вставляется в набиралку на телефоне
    'Телефон': l.phones[0] ? dialPhone(l.phones[0]) : '',
    'Другие телефоны': l.phones.slice(1).map(dialPhone).join(', '),
    'Заметка': l.note || '', 'Последний комментарий': lastNote(l),
    'Последний звонок': fmtDT(l.lastCallAt), 'Звонков': l.attempts || 0,
    'История': (l.history || []).map(h => `${fmtDT(h.t)} ${ST[h.s]?.label}${h.n ? ': ' + h.n : ''}`).join('\n'),
    'Категория': l.category, 'Город': l.city, 'Адрес': l.address,
    'Рейтинг': l.rating, 'Отзывов': l.reviewsCount, 'Сайты': l.sites.join('\n'), 'Соцсети': l.socials.join('\n'),
    'Email': l.email, 'Режим работы': l.hours, 'Яндекс Карты': (l.mapLinks || [])[0] || '', 'ID': l.id.slice(1),
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = Object.keys(rows[0]).map(k => ({ wch: { 'Название': 30, 'Телефон': 15, 'Другие телефоны': 28, 'История': 40, 'Адрес': 35, 'Заметка': 30, 'Последний комментарий': 30 }[k] || 14 }));
  ws['!autofilter'] = { ref: ws['!ref'] };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Лиды');
  XLSX.writeFile(wb, `lids_${dateStamp()}.xlsx`);
  toast(`Выгружено: ${list.length}`, 'ok');
}
function backup() {
  const data = { app: 'lids-crm', version: 1, exportedAt: new Date().toISOString(), leads: [...state.leads.values()], imports: state.imports };
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `lids_backup_${dateStamp()}.json`);
  ls.set('lastBackup', Date.now());
  ls.set('changesSinceBackup', 0);
  updateBackupNote();
}
async function restore(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'lids-crm' || !Array.isArray(data.leads)) throw new Error('это не резервная копия Лиды CRM');
    if (!confirm(`В копии ${data.leads.length} карточек от ${fmtDT(Date.parse(data.exportedAt))}.\nТекущая база (${state.leads.size}) будет ЗАМЕНЕНА. Продолжить?`)) return;
    await DB.clear('leads'); await DB.clear('imports');
    await DB.putMany('leads', data.leads); await DB.putMany('imports', data.imports || []);
    await loadAll();
    toast('База восстановлена', 'ok');
  } catch (e) { toast('Не удалось восстановить: ' + e.message, 'err'); }
}
function updateBackupNote() {
  const t = ls.get('lastBackup', 0);
  const el = $('#backupNote');
  const stale = !t || Date.now() - t > 3 * DAY;
  el.textContent = t ? `Последняя копия: ${fmtAgo(t)}` : 'Резервной копии ещё не было';
  el.classList.toggle('warn', stale && state.leads.size > 0);
}
function updateCallbackBadge() {
  const n = [...state.leads.values()].filter(isDue).length;
  $('#cbCount').textContent = n;
  $('#btnCallbacks').classList.toggle('hidden', n === 0);
}

/* =========================== НАВИГАЦИЯ / МОДАЛ =========================== */
function openModal(html) { $('#modalBox').innerHTML = html; $('#modal').classList.add('open'); }
function closeModal() { $('#modal').classList.remove('open'); $('#modalBox').onclick = null; }

function setView(v) {
  state.view = v;
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  renderView();
}
function renderView() {
  if (state.view === 'base') renderBase();
  if (state.view === 'call') { renderCallSetup(); renderCallCard(); }
  if (state.view === 'stats') renderStats();
  if (state.view === 'imports') renderImports();
}
function renderAll() {
  renderFilterOptions();
  updateCallbackBadge();
  updateBackupNote();
  renderView();
  if (state.drawerId) renderDrawer();
}

async function loadAll() {
  const [leads, imports] = await Promise.all([DB.all('leads'), DB.all('imports')]);
  state.leads = new Map(leads.map(l => [l.id, l]));
  state.imports = imports;
  searchCache.clear();
  state.selected.clear();
  rebuildPhoneIndex();
  renderAll();
}

/* =========================== СОБЫТИЯ =========================== */
function bind() {
  $$('.tabs button').forEach(b => b.onclick = () => setView(b.dataset.view));
  $('#fileInput').onchange = async e => { await handleFiles([...e.target.files]); e.target.value = ''; };

  // Ctrl+C по выделенному тексту — в буфер идёт только чистый текст, без HTML-разметки и ссылок.
  // Если выделен один номер — кладём его в виде +79676701771.
  document.addEventListener('copy', e => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const text = String(window.getSelection() || '').trim();
    if (!text) return;
    const phones = extractPhones(text);
    const onlyPhone = phones.length === 1 && text.replace(/[\d\s+()-]/g, '') === '';
    e.clipboardData.setData('text/plain', onlyPhone ? dialPhone(phones[0]) : text);
    e.preventDefault();
  });

  // drag & drop файлов в окно
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    const files = [...e.dataTransfer.files].filter(f => /\.(xlsx|xls|csv)$/i.test(f.name));
    if (files.length) handleFiles(files);
  });

  // меню
  $('#btnMenu').onclick = e => { e.stopPropagation(); updateBackupNote(); $('#menuPop').classList.toggle('open'); };
  document.addEventListener('click', () => $('#menuPop').classList.remove('open'));
  $('#menuPop').onclick = async e => {
    const m = e.target.closest('[data-menu]')?.dataset.menu;
    if (!m) return;
    $('#menuPop').classList.remove('open');
    if (m === 'export') exportXlsx();
    if (m === 'backup') backup();
    if (m === 'restore') $('#restoreInput').click();
    if (m === 'clear') {
      if (!state.leads.size) return;
      if (!confirm(`Удалить ВСЮ базу (${state.leads.size} карточек) вместе с историей звонков?`)) return;
      if (!confirm('Точно? Если нет резервной копии — это не отменить.')) return;
      await DB.clear('leads'); await DB.clear('imports');
      await loadAll();
      toast('База очищена');
    }
  };
  $('#restoreInput').onchange = e => { if (e.target.files[0]) restore(e.target.files[0]); e.target.value = ''; };

  $('#btnCallbacks').onclick = () => {
    Object.assign(state.f, { callback: 'due', statuses: [], sort: 'last', dir: -1, page: 1 });
    setView('base');
    renderFilterOptions();
  };

  // фильтры
  const f = state.f;
  $('#fSearch').oninput = debounce(e => { f.q = e.target.value; f.page = 1; renderBase(); }, 150);
  [['#fNiche', 'niche'], ['#fCity', 'city'], ['#fSite', 'site'], ['#fCallback', 'callback'], ['#fImport', 'importId']]
    .forEach(([sel, k]) => { $(sel).onchange = e => { f[k] = e.target.value; f.page = 1; renderBase(); }; });
  $('#fReset').onclick = () => {
    Object.assign(f, { q: '', niche: '', city: '', site: '', callback: '', importId: '', statuses: [], page: 1 });
    $('#fSearch').value = '';
    renderFilterOptions();
    renderBase();
  };
  $('#statusChips').onclick = e => {
    const c = e.target.closest('[data-st]');
    if (!c) return;
    const k = c.dataset.st;
    if (!k) f.statuses = [];
    else if (e.ctrlKey || e.metaKey || e.shiftKey) f.statuses = f.statuses.includes(k) ? f.statuses.filter(x => x !== k) : [...f.statuses, k];
    else f.statuses = f.statuses.length === 1 && f.statuses[0] === k ? [] : [k];
    f.page = 1;
    renderBase();
  };
  $$('.leads th[data-sort]').forEach(th => th.onclick = () => {
    const k = th.dataset.sort;
    if (f.sort === k) f.dir = -f.dir; else { f.sort = k; f.dir = k === 'name' || k === 'niche' ? 1 : -1; }
    renderBase();
  });
  $('#pager').onclick = e => { const b = e.target.closest('[data-page]'); if (b) { f.page = +b.dataset.page; renderBase(); $('.table-wrap').scrollTop = 0; } };

  // таблица
  $('#leadRows').onclick = e => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    if (e.target.classList.contains('rsel')) {
      e.target.checked ? state.selected.add(id) : state.selected.delete(id);
      tr.classList.toggle('sel', e.target.checked);
      renderBulkbar();
      return;
    }
    if (e.target.closest('a, select, input')) return;
    openDrawer(id);
  };
  $('#leadRows').onchange = e => {
    if (!e.target.classList.contains('st')) return;
    const l = state.leads.get(e.target.closest('tr').dataset.id);
    applyStatus(l, e.target.value);
  };
  $('#selPage').onchange = e => {
    const page = state.filtered.slice((f.page - 1) * PAGE_SIZE, f.page * PAGE_SIZE);
    page.forEach(l => e.target.checked ? state.selected.add(l.id) : state.selected.delete(l.id));
    renderBase();
  };

  // массовые действия
  $('#bulkStatus').innerHTML += STATUSES.map(s => `<option value="${s.key}">${s.label}</option>`).join('');
  $('#selAllFiltered').onclick = () => { state.filtered.forEach(l => state.selected.add(l.id)); renderBase(); };
  $('#bulkClear').onclick = () => { state.selected.clear(); renderBase(); };
  $('#bulkStatus').onchange = e => {
    const st = e.target.value;
    e.target.value = '';
    if (!st) return;
    const list = [...state.selected].map(id => state.leads.get(id)).filter(Boolean);
    if (!confirm(`Поставить статус «${ST[st].label}» для ${list.length} карточек?`)) return;
    list.forEach(l => setStatus(l, st, { note: 'массово' }));
    saveLeads(list);
    refreshAfterChange();
  };
  $('#bulkNicheApply').onclick = () => {
    const n = $('#bulkNiche').value.trim();
    const list = [...state.selected].map(id => state.leads.get(id)).filter(Boolean);
    if (!confirm(`Сменить нишу на «${n || 'без ниши'}» для ${list.length} карточек?`)) return;
    list.forEach(l => { l.niche = n; });
    saveLeads(list);
    $('#bulkNiche').value = '';
    renderAll();
  };
  $('#bulkDelete').onclick = () => {
    const ids = [...state.selected];
    if (confirm(`Удалить ${ids.length} карточек вместе с историей?`)) deleteLeads(ids);
  };

  // карточка
  $('#drawer').addEventListener('click', onDrawerClick);
  $('#drawer').addEventListener('change', onDrawerChange);
  $('#drawerBack').onclick = closeDrawer;

  // прозвон
  $('#callCard').addEventListener('click', onCallClick);
  $('#callCard').addEventListener('change', onCallChange);
  $('#qBuild').onclick = buildQueue;
  ['#qNiche', '#qCity', '#qSite', '#qDueOnly', '#qAutoNext', '#qSamePhone'].forEach(s => $(s).addEventListener('change', () => { readCallSetup(); updateQueueInfo(); }));
  $('#qStatuses').onchange = () => { readCallSetup(); updateQueueInfo(); };

  // статистика / импорты
  $('#statsBody').onclick = e => {
    const tr = e.target.closest('[data-niche]');
    if (!tr) return;
    Object.assign(state.f, { niche: tr.dataset.niche, statuses: [], callback: '', importId: '', page: 1 });
    setView('base');
    renderFilterOptions();
    renderBase();
  };
  $('#importsBody').onclick = e => {
    const s = e.target.closest('[data-imp-show]');
    if (s) {
      Object.assign(state.f, { importId: s.dataset.impShow, niche: '', city: '', statuses: [], callback: '', page: 1 });
      setView('base');
      renderFilterOptions();
      renderBase();
    }
    const d = e.target.closest('[data-imp-del]');
    if (d) deleteImport(d.dataset.impDel);
  };

  $('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') { closeModal(); } });

  // горячие клавиши
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if ($('#modal').classList.contains('open')) return closeModal();
      if (state.drawerId) return closeDrawer();
    }
    if (state.view !== 'call' || state.drawerId || $('#modal').classList.contains('open')) return;
    if (!currentCallLead()) return;
    const tag = e.target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    const m = e.code.match(/^(?:Digit|Numpad)([1-8])$/);
    if (m && (!typing || e.altKey) && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      callSetStatus(STATUSES[+m[1] - 1].key);
      return;
    }
    if (typing) {
      if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); callNext(); }
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); callNext(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); callPrev(); }
    else if (e.code === 'KeyC' && !e.ctrlKey && !e.metaKey) {
      const l = currentCallLead();
      if (l.phones[0]) copyText('+' + l.phones[0]);
    }
  });

  // раз в минуту обновляем счётчик перезвонов
  setInterval(updateCallbackBadge, 60e3);
}

/* =========================== СТАРТ =========================== */
(async function init() {
  if (typeof XLSX === 'undefined') {
    document.body.innerHTML = '<div class="empty"><h3>Не найдена библиотека lib/xlsx.full.min.js</h3><p>Она должна лежать рядом с index.html в папке lib.</p></div>';
    return;
  }
  bind();
  try {
    await DB.open();
    navigator.storage?.persist?.();
    await loadAll();
  } catch (e) {
    console.error(e);
    toast('Не удалось открыть базу браузера: ' + e.message, 'err');
  }
})();
