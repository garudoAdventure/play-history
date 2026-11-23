'use strict';

/* ================= 設定 ================= */

const STORAGE_KEY = 'play-history.v1';

const CATEGORIES = {
  video: { label: '電玩遊戲', icon: '🎮' },
  board: { label: '桌遊', icon: '🎲' },
  escape: { label: '密室逃脫', icon: '🔐' },
};

const byRecent = (a, b) =>
  (b.playedAt || '').localeCompare(a.playedAt || '') || b.createdAt - a.createdAt;

const SORTS = {
  recent: { label: '最近遊玩', fn: byRecent },
  rating: { label: '評價最高', fn: (a, b) => b.rating - a.rating || byRecent(a, b) },
  title: { label: '名稱排序', fn: (a, b) => a.title.localeCompare(b.title, 'zh-Hant') },
};

/* ================= 執行環境 =================
 * 一般網頁：資料存在 localStorage。
 * Claude artifact：資料存在 artifact 的 db（每個人自己的私人區域 data/users/<id>/），
 * 登入同一個 Claude 帳號的不同裝置都看得到。
 */

const ID_RE = /^[A-Za-z0-9_\-~:@+]{1,100}$/;

const IN_ARTIFACT = typeof window.claude?.use === 'function';

const app = document.getElementById('app');
const listState = { category: 'all', query: '', tag: null, sort: 'recent' };

let games = IN_ARTIFACT ? [] : loadLocal();
let cloud = null;            // db collection（artifact 模式）
let downloadsApi = null;     // artifact 的下載功能
let loading = IN_ARTIFACT;   // 等待雲端資料中
let statusNote = '';         // 顯示在列表上方的狀態訊息
let currentView = 'list';

/* ================= 資料 ================= */

function newId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** 把任意物件整理成合法的遊戲紀錄；不合法則回傳 null。 */
function normalizeGame(x) {
  if (!x || typeof x !== 'object' || typeof x.title !== 'string' || !x.title.trim()) return null;
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const tags = Array.isArray(x.tags)
    ? [...new Set(x.tags.filter((t) => typeof t === 'string').map((t) => t.trim()).filter(Boolean))]
    : [];
  const now = Date.now();
  return {
    id: typeof x.id === 'string' && ID_RE.test(x.id) ? x.id : newId(),
    title: x.title.trim(),
    category: CATEGORIES[x.category] ? x.category : 'video',
    rating: Math.min(5, Math.max(0, Math.round(Number(x.rating) || 0))),
    tags,
    pros: str(x.pros),
    cons: str(x.cons),
    playedAt: /^\d{4}-\d{2}-\d{2}$/.test(x.playedAt) ? x.playedAt : '',
    createdAt: Number(x.createdAt) || now,
    updatedAt: Number(x.updatedAt) || now,
  };
}

function loadLocal() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(data) ? data.map(normalizeGame).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(games));
    return true;
  } catch (err) {
    notice('儲存失敗：' + err.message);
    return false;
  }
}

function writeErrorMessage(err) {
  if (err?.code === 'quota_exceeded') return '儲存空間已滿，請刪除一些紀錄後再試。';
  if (err?.code === 'invalid_argument') return '你沒有寫入這份資料的權限。';
  return '儲存失敗，請檢查網路後再試一次。';
}

/** 新增或更新一筆（呼叫前 games 陣列已更新）。 */
async function persistGame(g) {
  if (!cloud) return saveLocal();
  try {
    await cloud.doc(g.id).set({ ...g });
    return true;
  } catch (err) {
    notice(writeErrorMessage(err));
    return false;
  }
}

async function removeGame(id) {
  games = games.filter((x) => x.id !== id);
  if (!cloud) return saveLocal();
  try {
    await cloud.doc(id).delete();
    return true;
  } catch (err) {
    notice(writeErrorMessage(err));
    return false;
  }
}

const findGame = (id) => games.find((g) => g.id === id);

/* ================= 雲端（artifact 模式） ================= */

async function initCloud() {
  const giveUp = (msg) => {
    games = loadLocal();
    loading = false;
    statusNote = msg;
    refreshView();
  };

  let db, user, uid;
  try {
    [db, user, downloadsApi] = await Promise.all([
      claude.use('db'), claude.use('user'), claude.use('downloads'),
    ]);
    uid = user ? await user.id() : null;
  } catch {
    return giveUp('無法連線到雲端，資料只會暫存在這個瀏覽器。');
  }
  if (!db || !uid) return giveUp('目前無法使用雲端儲存（可能未登入），資料只會暫存在這個瀏覽器。');

  cloud = db.collection('data/users/' + uid);
  const timer = setTimeout(() => {
    statusNote = '暫時連不上資料，連上後會自動更新。';
    refreshView();
  }, 10000);

  cloud.onSnapshot(
    (snap) => {
      games = snap.docs.map((d) => normalizeGame({ ...d.data(), id: d.id })).filter(Boolean);
      if (!snap.metadata.fromCache) {
        clearTimeout(timer);
        loading = false;
        statusNote = '';
      }
      refreshView();
    },
    () => {
      clearTimeout(timer);
      loading = false;
      statusNote = '與資料的連線中斷，請重新開啟頁面。';
      refreshView();
    },
  );
}

/** 資料變動後更新目前畫面（編輯中的表單不動）。 */
function refreshView() {
  if (currentView === 'list') updateList();
  else if (currentView === 'detail') route(true);
}

/* ================= 小工具 ================= */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function starsHtml(n) {
  let s = '';
  for (let i = 1; i <= 5; i++) s += `<span class="${i <= n ? 'on' : ''}">★</span>`;
  return `<span class="stars" role="img" aria-label="${n} 顆星">${s}</span>`;
}

function today() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

const splitLines = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 2000);
}

/** 頁面內建的對話框（artifact 中不能用 alert / confirm）。 */
function openSheet(html) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = html;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  return dlg;
}

function ask(message, { ok = '確定', cancel = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = openSheet(`
      <p class="msg"></p>
      <div class="actions">
        ${cancel ? `<button class="btn ghost" value="no">${cancel}</button>` : ''}
        <button class="btn${danger ? ' danger' : ''}" value="yes">${ok}</button>
      </div>`);
    dlg.querySelector('.msg').textContent = message;
    dlg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[value]');
      if (!btn) return;
      dlg.returnValue = btn.value;
      dlg.close();
    });
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'yes'));
  });
}

const notice = (message) => ask(message, { ok: '好', cancel: '' });

/* ================= 路由 =================
 * （空）         列表
 * #new           新增
 * #game-<id>     詳細
 * #edit-<id>     編輯
 * 用 history.state.depth 記錄在 App 內的深度，讓「返回」在直接開啟深層網址時也不會跳出 App。
 */

let depth = 0;
let replacing = false;

function syncDepth() {
  if (history.state && typeof history.state.depth === 'number') {
    depth = history.state.depth;
  } else {
    if (!replacing) depth++;
    history.replaceState({ depth }, '');
  }
  replacing = false;
}

function replaceHash(hash) {
  if (location.hash === hash) return route();
  replacing = true;
  location.replace(hash);
}

function goBack(fallback) {
  if (depth > 0) history.back();
  else replaceHash(fallback);
}

function route(keepScroll = false) {
  const h = decodeURIComponent(location.hash.slice(1));
  const prefix = h.match(/^(game|edit)-(.+)$/);
  const game = prefix && findGame(prefix[2]);

  if (h === 'new') renderForm(null);
  else if (prefix?.[1] === 'edit' && game) renderForm(game);
  else if (prefix?.[1] === 'game' && game) renderDetail(game);
  else if (prefix && loading) renderLoading();
  else renderList();

  if (!keepScroll) window.scrollTo(0, 0);
}

function renderLoading() {
  currentView = 'detail';
  app.innerHTML = `
    <header class="topbar"><button class="icon-btn" id="back" aria-label="返回">‹</button><h1></h1></header>
    <p class="empty">載入中…</p>`;
  app.querySelector('#back').addEventListener('click', () => goBack('#list'));
}

/* ================= 列表頁 ================= */

function renderList() {
  currentView = 'list';
  const tabs = [['all', '全部'], ...Object.entries(CATEGORIES).map(([k, c]) => [k, `${c.icon} ${c.label}`])];
  app.innerHTML = `
    <header class="topbar">
      <h1>遊玩紀錄</h1>
      <button class="icon-btn" id="menu-btn" aria-label="資料備份">⋯</button>
    </header>
    <nav class="tabs">
      ${tabs.map(([k, l]) => `<button class="tab" data-cat="${k}">${l}</button>`).join('')}
    </nav>
    <div class="toolbar">
      <input type="search" id="search" placeholder="搜尋名稱或標籤" value="${esc(listState.query)}" autocomplete="off">
      <select id="sort" aria-label="排序">
        ${Object.entries(SORTS).map(([k, s]) =>
          `<option value="${k}"${k === listState.sort ? ' selected' : ''}>${s.label}</option>`).join('')}
      </select>
    </div>
    <p class="status" id="status" hidden></p>
    <div class="tag-filter" id="tag-filter"></div>
    <p class="count" id="count"></p>
    <ul class="game-list" id="game-list"></ul>
    <a href="#new" class="fab" aria-label="新增遊戲">＋</a>`;

  app.querySelector('.tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    listState.category = btn.dataset.cat;
    updateList();
  });
  app.querySelector('#search').addEventListener('input', (e) => {
    listState.query = e.target.value;
    updateList();
  });
  app.querySelector('#sort').addEventListener('change', (e) => {
    listState.sort = e.target.value;
    updateList();
  });
  app.querySelector('#tag-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    listState.tag = listState.tag === btn.dataset.tag ? null : btn.dataset.tag;
    updateList();
  });
  app.querySelector('#menu-btn').addEventListener('click', openBackupDialog);

  updateList();
}

function updateList() {
  const status = app.querySelector('#status');
  status.textContent = statusNote;
  status.hidden = !statusNote;

  app.querySelectorAll('.tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.cat === listState.category));

  const inCategory = games.filter((g) => listState.category === 'all' || g.category === listState.category);

  // 標籤篩選列：只顯示目前分類中有用到的標籤，依使用次數排序
  const tagCount = new Map();
  inCategory.forEach((g) => g.tags.forEach((t) => tagCount.set(t, (tagCount.get(t) || 0) + 1)));
  if (listState.tag && !tagCount.has(listState.tag) && !loading) listState.tag = null;
  const tags = [...tagCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hant'));
  const tagFilter = app.querySelector('#tag-filter');
  tagFilter.hidden = tags.length === 0;
  tagFilter.innerHTML = tags.map(([t, n]) =>
    `<button class="chip${t === listState.tag ? ' active' : ''}" data-tag="${esc(t)}">#${esc(t)} <small>${n}</small></button>`
  ).join('');

  const q = listState.query.trim().toLowerCase();
  const shown = inCategory
    .filter((g) => !listState.tag || g.tags.includes(listState.tag))
    .filter((g) => !q || g.title.toLowerCase().includes(q) || g.tags.some((t) => t.toLowerCase().includes(q)))
    .sort(SORTS[listState.sort].fn);

  app.querySelector('#count').textContent = shown.length ? `共 ${shown.length} 筆` : '';

  const list = app.querySelector('#game-list');
  if (shown.length) {
    list.innerHTML = shown.map(cardHtml).join('');
  } else if (loading) {
    list.innerHTML = `<li class="empty">載入中…</li>`;
  } else if (games.length === 0) {
    list.innerHTML = `<li class="empty"><span class="big">🕹️</span>還沒有任何紀錄<br>點右下角的 ＋ 新增第一筆吧！</li>`;
  } else {
    list.innerHTML = `<li class="empty"><span class="big">🔍</span>沒有符合條件的紀錄</li>`;
  }
}

function cardHtml(g) {
  const cat = CATEGORIES[g.category];
  return `
    <li>
      <a class="card" href="#game-${g.id}">
        <span class="card-icon" aria-label="${cat.label}">${cat.icon}</span>
        <div class="card-body">
          <div class="card-title">${esc(g.title)}</div>
          <div class="card-meta">
            ${g.rating ? starsHtml(g.rating) : '<span>未評分</span>'}
            <span>${g.playedAt || ''}</span>
          </div>
          ${g.tags.length ? `<div class="card-tags">${g.tags.map((t) => `<span class="chip">#${esc(t)}</span>`).join('')}</div>` : ''}
        </div>
      </a>
    </li>`;
}

/* ================= 詳細頁 ================= */

function noteHtml(text) {
  const items = splitLines(text);
  if (!items.length) return '<p class="muted">（尚未填寫）</p>';
  return `<ul>${items.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`;
}

function renderDetail(g) {
  currentView = 'detail';
  const cat = CATEGORIES[g.category];
  app.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" id="back" aria-label="返回">‹</button>
      <h1>${esc(g.title)}</h1>
      <a class="text-btn" href="#edit-${g.id}">編輯</a>
    </header>
    <section class="detail">
      <div class="detail-head">
        <span class="badge">${cat.icon} ${cat.label}</span>
        ${g.playedAt ? `<span class="muted">${g.playedAt}</span>` : ''}
      </div>
      <div class="detail-rating">${g.rating ? starsHtml(g.rating) : '<span class="muted" style="font-size:16px">未評分</span>'}</div>
      ${g.tags.length ? `<div class="detail-tags">${g.tags.map((t) =>
        `<button class="chip" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
      <div class="note good"><h2>👍 好玩的地方</h2>${noteHtml(g.pros)}</div>
      <div class="note bad"><h2>👎 不好玩的地方</h2>${noteHtml(g.cons)}</div>
      <button class="danger-btn" id="delete">刪除這筆紀錄</button>
    </section>`;

  app.querySelector('#back').addEventListener('click', () => goBack('#list'));

  // 點標籤 → 回到列表並以該標籤篩選
  app.querySelector('.detail-tags')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    Object.assign(listState, { category: g.category, tag: btn.dataset.tag, query: '' });
    goBack('#list');
  });

  app.querySelector('#delete').addEventListener('click', async () => {
    if (!(await ask(`確定要刪除「${g.title}」嗎？此動作無法復原。`, { ok: '刪除', danger: true }))) return;
    goBack('#list');
    if (await removeGame(g.id)) toast('已刪除');
  });
}

/* ================= 新增 / 編輯 ================= */

function renderForm(g) {
  currentView = 'form';
  const isNew = !g;
  const draft = g
    ? { ...g, tags: [...g.tags] }
    : {
        title: '',
        category: listState.category !== 'all' ? listState.category : 'video',
        rating: 0,
        tags: [],
        pros: '',
        cons: '',
        playedAt: today(),
      };

  app.innerHTML = `
    <header class="topbar center">
      <button class="text-btn" id="cancel">取消</button>
      <h1>${isNew ? '新增紀錄' : '編輯紀錄'}</h1>
      <button class="text-btn primary" type="submit" form="game-form">儲存</button>
    </header>
    <form id="game-form" class="form" novalidate>
      <div class="field" id="title-field">
        <label for="title" class="label">名稱</label>
        <input id="title" name="title" maxlength="100" value="${esc(draft.title)}" autocomplete="off" placeholder="遊戲名稱">
        <p class="error" hidden>請輸入名稱</p>
      </div>

      <fieldset class="field">
        <legend>種類</legend>
        <div class="segmented">
          ${Object.entries(CATEGORIES).map(([k, c]) => `
            <label><input type="radio" name="category" value="${k}"${k === draft.category ? ' checked' : ''}><span>${c.icon} ${c.label}</span></label>`).join('')}
        </div>
      </fieldset>

      <fieldset class="field">
        <legend>評價</legend>
        <div class="star-input" id="star-input">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" aria-label="${n} 顆星">★</button>`).join('')}
          <span class="hint" id="star-hint"></span>
        </div>
      </fieldset>

      <div class="field">
        <label for="playedAt" class="label">遊玩日期</label>
        <input type="date" id="playedAt" name="playedAt" value="${draft.playedAt || ''}">
      </div>

      <div class="field">
        <label for="tag-input" class="label">標籤</label>
        <div class="tag-editor">
          <span id="tag-chips" style="display:contents"></span>
          <div class="row">
            <input id="tag-input" placeholder="輸入標籤" autocomplete="off" enterkeyhint="enter">
            <button type="button" class="add-tag" id="add-tag">加入</button>
          </div>
        </div>
        <div class="tag-suggest" id="tag-suggest"></div>
      </div>

      <div class="field">
        <label for="pros" class="label">👍 好玩的地方</label>
        <textarea id="pros" name="pros" rows="4" placeholder="一行寫一點">${esc(draft.pros)}</textarea>
      </div>

      <div class="field">
        <label for="cons" class="label">👎 不好玩的地方</label>
        <textarea id="cons" name="cons" rows="4" placeholder="一行寫一點">${esc(draft.cons)}</textarea>
      </div>
    </form>`;

  const form = app.querySelector('#game-form');
  const titleInput = form.elements.namedItem('title');
  const fallback = isNew ? '#list' : `#game-${g.id}`;

  app.querySelector('#cancel').addEventListener('click', () => goBack(fallback));

  /* --- 星數 --- */
  const starInput = app.querySelector('#star-input');
  const updateStars = () => {
    starInput.querySelectorAll('button').forEach((b) =>
      b.classList.toggle('on', Number(b.dataset.n) <= draft.rating));
    app.querySelector('#star-hint').textContent =
      draft.rating ? `${draft.rating} / 5（再點一次可取消）` : '未評分';
  };
  starInput.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const n = Number(btn.dataset.n);
    draft.rating = draft.rating === n ? 0 : n;
    updateStars();
  });
  updateStars();

  /* --- 標籤 --- */
  const tagInput = app.querySelector('#tag-input');
  const tagChips = app.querySelector('#tag-chips');
  const tagSuggest = app.querySelector('#tag-suggest');

  const allTags = () => {
    const count = new Map();
    games.forEach((x) => x.tags.forEach((t) => count.set(t, (count.get(t) || 0) + 1)));
    return [...count].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  };

  const renderTags = () => {
    tagChips.innerHTML = draft.tags.map((t, i) =>
      `<span class="chip">#${esc(t)}<button type="button" data-i="${i}" aria-label="移除 ${esc(t)}">×</button></span>`
    ).join('');
    const q = tagInput.value.trim().toLowerCase();
    const suggestions = allTags()
      .filter((t) => !draft.tags.includes(t) && (!q || t.toLowerCase().includes(q)))
      .slice(0, 12);
    tagSuggest.innerHTML = suggestions.map((t) =>
      `<button type="button" class="chip" data-tag="${esc(t)}">＋ ${esc(t)}</button>`).join('');
  };

  const addTags = (text) => {
    text.split(/[,，、]/).map((t) => t.trim().replace(/^#+/, '')).filter(Boolean).forEach((t) => {
      if (!draft.tags.includes(t)) draft.tags.push(t);
    });
  };

  const commitTagInput = () => {
    if (!tagInput.value.trim()) return;
    addTags(tagInput.value);
    tagInput.value = '';
    renderTags();
  };

  tagInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 中文輸入法選字中，不處理
    if (e.key === 'Enter') {
      e.preventDefault();
      commitTagInput();
    } else if (e.key === 'Backspace' && !tagInput.value && draft.tags.length) {
      draft.tags.pop();
      renderTags();
    }
  });
  tagInput.addEventListener('input', () => {
    if (/[,，、]/.test(tagInput.value)) commitTagInput();
    else renderTags();
  });
  app.querySelector('#add-tag').addEventListener('click', () => {
    commitTagInput();
    tagInput.focus();
  });
  tagChips.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-i]');
    if (!btn) return;
    draft.tags.splice(Number(btn.dataset.i), 1);
    renderTags();
  });
  tagSuggest.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    draft.tags.push(btn.dataset.tag);
    tagInput.value = '';
    renderTags();
  });
  renderTags();

  /* --- 名稱驗證 --- */
  const titleField = app.querySelector('#title-field');
  titleInput.addEventListener('input', () => {
    titleField.classList.remove('invalid');
    titleField.querySelector('.error').hidden = true;
  });

  /* --- 儲存 --- */
  let saving = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;
    commitTagInput();

    const title = titleInput.value.trim();
    if (!title) {
      titleField.classList.add('invalid');
      titleField.querySelector('.error').hidden = false;
      titleInput.focus();
      return;
    }

    const fd = new FormData(form);
    const now = Date.now();
    const data = {
      title,
      category: fd.get('category'),
      rating: draft.rating,
      tags: draft.tags,
      pros: fd.get('pros').trim(),
      cons: fd.get('cons').trim(),
      playedAt: fd.get('playedAt') || '',
      updatedAt: now,
    };

    saving = true;
    if (isNew) {
      const created = normalizeGame({ ...data, id: newId(), createdAt: now });
      games.push(created);
      if (!(await persistGame(created))) {
        games = games.filter((x) => x !== created);
        saving = false;
        return;
      }
      toast('已新增');
      replaceHash(`#game-${created.id}`);
    } else {
      const before = { ...g };
      Object.assign(g, normalizeGame({ ...g, ...data }));
      if (!(await persistGame(g))) {
        Object.assign(g, before);
        saving = false;
        return;
      }
      toast('已儲存');
      goBack(fallback);
    }
  });

  if (isNew) titleInput.focus();
}

/* ================= 備份（匯出 / 匯入） ================= */

function openBackupDialog() {
  const where = cloud
    ? '紀錄存在你的 Claude 帳號裡，用同一個帳號在其他裝置打開這個頁面也看得到。'
    : '紀錄只存在這台裝置的瀏覽器裡，清除瀏覽器資料就會消失。建議定期匯出備份，也可以用來搬到其他裝置。';
  const canExport = !IN_ARTIFACT || downloadsApi;
  const dlg = openSheet(`
    <h2>資料備份</h2>
    <p class="muted">${where}</p>
    <p class="muted">目前共 ${games.length} 筆紀錄。</p>
    ${canExport ? '<button class="btn" id="export">匯出備份檔（JSON）</button>' : ''}
    <label class="btn">匯入備份檔<input type="file" id="import" accept="application/json,.json" hidden></label>
    <button class="btn ghost" id="close">關閉</button>`);
  dlg.querySelector('#close').addEventListener('click', () => dlg.close());
  dlg.querySelector('#export')?.addEventListener('click', exportData);
  dlg.querySelector('#import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    dlg.close();
    await importData(file);
  });
}

async function exportData() {
  const payload = { app: 'play-history', version: 1, exportedAt: new Date().toISOString(), games };
  const json = JSON.stringify(payload, null, 2);
  const filename = `play-history-${today()}.json`;

  if (downloadsApi) {
    try {
      await downloadsApi.save({ filename, data: json });
      toast('已匯出');
    } catch (err) {
      if (err?.code !== 'declined') notice('匯出失敗，請稍後再試。');
    }
    return;
  }

  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importData(file) {
  let items;
  try {
    const data = JSON.parse(await file.text());
    items = (Array.isArray(data) ? data : data?.games || []).map(normalizeGame).filter(Boolean);
  } catch {
    return notice('無法讀取檔案，請確認是本 App 匯出的 JSON 備份檔。');
  }
  if (!items.length) return notice('檔案中沒有可匯入的紀錄。');

  const existing = new Set(games.map((g) => g.id));
  const overlap = items.filter((g) => existing.has(g.id)).length;
  const msg = `將匯入 ${items.length} 筆紀錄`
    + (overlap ? `，其中 ${overlap} 筆與現有紀錄相同，會以備份檔內容覆蓋` : '')
    + '。確定要匯入嗎？';
  if (!(await ask(msg, { ok: '匯入' }))) return;

  const byId = new Map(games.map((g) => [g.id, g]));
  items.forEach((g) => byId.set(g.id, g));
  games = [...byId.values()];

  if (cloud) {
    let done = 0;
    for (const g of items) {
      try {
        await cloud.doc(g.id).set({ ...g });
        done++;
      } catch (err) {
        notice(`已匯入 ${done} 筆，其餘失敗：${writeErrorMessage(err)}`);
        refreshView();
        return;
      }
    }
  } else if (!saveLocal()) {
    return;
  }
  refreshView();
  toast(`已匯入 ${items.length} 筆`);
}

/* ================= 啟動 ================= */

if (!history.state || typeof history.state.depth !== 'number') history.replaceState({ depth: 0 }, '');
depth = history.state.depth;
window.addEventListener('hashchange', () => { syncDepth(); route(); });
route();

if (IN_ARTIFACT) {
  initCloud();
} else {
  // 其他分頁修改資料時同步
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) { games = loadLocal(); refreshView(); }
  });

  // 請瀏覽器不要自動清除本站資料（支援的瀏覽器才有效）
  navigator.storage?.persist?.();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
