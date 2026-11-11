/* 评测集标注工具 — 前端逻辑（无构建、无第三方依赖） */
(() => {
  'use strict';

  const TAG_GROUPS = [
    { label: '拍摄角度', options: [['front-view', '正面对打'], ['side-view', '侧面'], ['back-diagonal', '斜后方'], ['close-up', '近景']] },
    { label: '光线', options: [['bright', '明亮'], ['dim-light', '偏暗']] },
    { label: '画质', options: [['clear', '清晰'], ['ok', '一般'], ['blurry', '模糊'], ['shaky', '手抖']] },
    { label: '其他', options: [['noisy', '环境嘈杂'], ['left-hand', '左手持拍'], ['others-in-frame', '画面有旁人']] },
  ];

  const S = {
    data: null,
    index: 0,
    filter: 'all',
    pendingStart: null,
    timer: null,
    saving: false,
    queued: false,
    dirty: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const rows = () => (S.data ? S.data.rows : []);
  const row = () => rows()[S.index];

  // ─── 小工具 ───────────────────────────────────────────────────
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtTime = (t) => {
    const x = Math.max(0, Number(t) || 0);
    const m = Math.floor(x / 60);
    const s = x - m * 60;
    return pad2(m) + ':' + s.toFixed(1).padStart(4, '0');
  };
  const fmtClock = (iso) => { try { return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }); } catch (e) { return ''; } };
  const fmtSize = (bytes) => { if (!bytes) return ''; const mb = bytes / 1048576; return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb.toFixed(1) + ' MB'; };

  async function api(url, opts) {
    const res = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
    let data = {};
    try { data = await res.json(); } catch (e) { /* 空响应 */ }
    if (!res.ok) { const err = new Error(data.error || ('请求失败（' + res.status + '）')); err.data = data; throw err; }
    return data;
  }

  function openModal() {
    const m = $('#modal');
    m.hidden = false;
    m.classList.add('open');
  }

  function closeModal() {
    const m = $('#modal');
    m.classList.remove('open');
    m.hidden = true;
  }

  const isModalOpen = () => $('#modal').classList.contains('open');

  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }

  function setStatus(text, kind) {
    const el = $('#saveStatus');
    el.textContent = text;
    el.className = 'save-status' + (kind ? ' ' + kind : '');
  }

  function showMessages(kind, lines) {
    const box = $('#messages');
    box.className = 'messages ' + kind;
    box.hidden = false;
    box.innerHTML = lines[0] + (lines.length > 1 ? '<ul>' + lines.slice(1).map(l => '<li>' + esc(l) + '</li>').join('') + '</ul>' : '');
  }
  function hideMessages() { $('#messages').hidden = true; }

  // ─── 数据辅助 ─────────────────────────────────────────────────
  const issuesOf = (actionId) => (S.data && S.data.rulesByAction[actionId]) || [];

  function visibleRows() {
    return rows().map((r, i) => ({ r, i })).filter(({ r }) => {
      if (S.filter === 'todo') return !r.actionId;
      if (S.filter === 'missing') return !r.fileExists;
      return true;
    });
  }

  function firstVisibleIndex() {
    const v = visibleRows();
    return v.length ? v[0].i : -1;
  }

  // ─── 侧栏 ────────────────────────────────────────────────────
  function renderList() {
    const list = $('#list');
    list.innerHTML = '';
    const v = visibleRows();
    v.forEach(({ r, i }) => {
      const li = document.createElement('li');
      li.className = 'item' + (i === S.index ? ' active' : '');
      li.dataset.index = String(i);

      const name = document.createElement('span');
      name.className = 'item-name';
      name.textContent = r.videoId;
      name.title = r.videoFile;

      const badge = document.createElement('span');
      if (!r.fileExists) { badge.className = 'item-badge badge-missing'; badge.textContent = '缺视频'; }
      else if (r.actionId) { badge.className = 'item-badge badge-done'; badge.textContent = '已标注'; }
      else { badge.className = 'item-badge badge-todo'; badge.textContent = '未标注'; }

      li.appendChild(name);
      li.appendChild(badge);
      li.addEventListener('click', () => selectRow(i));
      list.appendChild(li);
    });

    const annotated = rows().filter(r => r.actionId).length;
    $('#doneCount').textContent = String(annotated);
    $('#totalCount').textContent = String(rows().length);
    $('#sidebarFoot').textContent = S.data ? '标注文件：' + S.data.labelsFile : '';
    updateFilterChips();
  }

  function updateFilterChips() {
    document.querySelectorAll('#filters .chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.filter === S.filter);
    });
  }

  // ─── 面板头部 / 视频 ──────────────────────────────────────────
  function renderPanelHead() {
    const r = row();
    if (!r) return;
    $('#panelTitle').textContent = r.videoId;
    $('#panelSub').textContent = r.videoFile + (r.notes ? ' · ' + r.notes : '');
    const badge = $('#panelBadge');
    if (!r.fileExists) { badge.textContent = '视频缺失'; badge.className = 'panel-badge'; badge.style.background = '#fff4e0'; badge.style.color = '#a86400'; }
    else if (r.actionId) { badge.textContent = r.actionId === 'none' ? '已标注（无效视频）' : '已标注 · ' + r.actionId; badge.style.background = '#e6f4ec'; badge.style.color = '#1f9254'; }
    else { badge.textContent = '未标注'; badge.style.background = '#eef1f4'; badge.style.color = '#6b7a88'; }
  }

  function renderVideo() {
    const r = row();
    const box = $('#videoBox');
    box.innerHTML = '';

    if (!r) return;
    if (!r.fileExists) {
      const div = document.createElement('div');
      div.className = 'video-missing';
      div.innerHTML = '视频文件不在 <code>eval/videos/</code> 里：<b>' + esc(r.videoFile) + '</b><br>请先把文件放进去（文件名要和这里一致），再点右上角「刷新」。';
      box.appendChild(div);
      return;
    }

    const v = document.createElement('video');
    v.id = 'player';
    v.controls = true;
    v.preload = 'metadata';
    v.playsInline = true;
    v.src = '/videos/' + encodeURIComponent(r.videoFile);
    v.addEventListener('error', () => {
      if (box.querySelector('.video-error')) return;
      const div = document.createElement('div');
      div.className = 'video-error';
      div.innerHTML = '这个格式当前浏览器打不开（<code>.MOV</code> 在 Chrome 里可能不支持）。<br>建议用 Safari 打开本页；或先把视频转成 mp4：<br><code>ffmpeg -i 原视频 -c:v libx264 -c:a aac 新视频.mp4</code>';
      box.appendChild(div);
    });
    box.appendChild(v);
  }

  // ─── 表单 ────────────────────────────────────────────────────
  function renderForm() {
    const r = row();
    const form = $('#form');
    if (!r) { form.innerHTML = ''; return; }

    const actionOptions = ['<option value="">— 请选择 —</option>']
      .concat((S.data.actions || []).map(a => '<option value="' + esc(a.id) + '"' + (r.actionId === a.id ? ' selected' : '') + '>' + esc(a.title) + '（' + esc(a.id) + '）</option>'))
      .concat('<option value="none"' + (r.actionId === 'none' ? ' selected' : '') + '>无效视频（没有可分析的击球动作）</option>');

    const segChips = [];
    let segHint = '';
    if (r.segments === 'none') {
      segHint = '<span class="empty-note">已标记：整段没有有效击球</span>';
    } else if (Array.isArray(r.segments) && r.segments.length) {
      r.segments.forEach((s, idx) => {
        segChips.push('<span class="seg-chip">' + fmtTime(s.start) + ' - ' + fmtTime(s.end) + ' <button type="button" data-del-seg="' + idx + '" title="删除">✕</button></span>');
      });
      segHint = segChips.join('');
    } else {
      segHint = '<span class="empty-note">还没标（可以先留空）</span>';
    }

    const pending = S.pendingStart != null ? '（起 ' + fmtTime(S.pendingStart) + '）' : '';

    const voice = [
      ['yes', '有清晰口令', r.hasVoice === true],
      ['no', '无口令，或听不清', r.hasVoice === false],
      ['', '未标注', r.hasVoice === null],
    ].map(([val, label, on]) => '<label class="radio-pill' + (on ? ' checked' : '') + '"><input type="radio" name="voice" value="' + val + '"' + (on ? ' checked' : '') + '>' + esc(label) + '</label>').join('');

    const hasAction = r.actionId && r.actionId !== 'none';
    let issuesHtml = '';
    if (!hasAction) {
      issuesHtml = '<p class="hint">先在上面选择「动作类型」，再来勾选问题点。</p>';
    } else if (r.issues === 'none') {
      issuesHtml = '<div class="toggle-row"><label class="chk-inline"><input type="checkbox" id="issuesNone" checked> 确认没有问题（不列出问题点）</label></div>' +
        '<p class="hint">已标记为「确认没有问题」。</p>';
    } else {
      const list = issuesOf(r.actionId);
      const checked = Array.isArray(r.issues) ? r.issues : [];
      issuesHtml = '<div class="toggle-row"><label class="chk-inline"><input type="checkbox" id="issuesNone"> 确认没有问题（不列出问题点）</label></div>' +
        '<div class="issue-list" style="margin-top:10px">' +
        list.map(it => {
          const on = checked.indexOf(it.issueId) >= 0;
          return '<label class="issue' + (on ? ' checked' : '') + '">' +
            '<input type="checkbox" data-issue="' + esc(it.issueId) + '"' + (on ? ' checked' : '') + '>' +
            '<span class="issue-main"><span class="issue-problem">' + esc(it.problem) + '</span>' +
            (it.evidence ? '<span class="issue-evidence">现象：' + esc(it.evidence) + '</span>' : '') +
            '<span class="issue-id">' + esc(it.issueId) + '</span></span>' +
            '</label>';
        }).join('') +
        '</div>';
    }

    const tagsHtml = TAG_GROUPS.map(group => {
      const chips = group.options.map(([key, label]) => {
        const on = r.tags.indexOf(key) >= 0;
        return '<label class="tag-chip' + (on ? ' checked' : '') + '"><input type="checkbox" data-tag="' + esc(key) + '"' + (on ? ' checked' : '') + '>' + esc(label) + '</label>';
      }).join('');
      return '<div class="tag-group-title">' + esc(group.label) + '</div><div class="tag-list">' + chips + '</div>';
    }).join('');

    form.innerHTML = [
      '<div class="field">',
      '<label class="field-label" for="actionSel">动作类型</label>',
      '<select id="actionSel">' + actionOptions.join('') + '</select>',
      '<p class="hint">视频里的主要技术动作。没有有效击球就选「无效视频」；拿不准可以先留空。</p>',
      '</div>',

      '<div class="field">',
      '<div class="field-label">有效击球片段 <span class="optional">点按钮取当前播放位置</span></div>',
      '<div class="seg-actions">',
      '<button class="btn" id="segStart" type="button"' + (r.fileExists ? '' : ' disabled') + '>设起点' + pending + '</button>',
      '<button class="btn" id="segEnd" type="button"' + (r.fileExists ? '' : ' disabled') + '>设终点</button>',
      '<button class="btn" id="segClear" type="button">清空</button>',
      '<label class="chk-inline"><input type="checkbox" id="segNone"' + (r.segments === 'none' ? ' checked' : '') + '>整段没有有效击球</label>',
      '</div>',
      '<div class="chips" id="segChips">' + segHint + '</div>',
      '<p class="hint">以「有效击球」为准：包含击球前的口令和准备动作，不含捡球、休息、讲解。可标多段。</p>',
      '</div>',

      '<div class="field">',
      '<div class="field-label">教练语音</div>',
      '<div class="radio-group">' + voice + '</div>',
      '<p class="hint">教练口令是否清晰可辨。这一项决定我们能不能保留「听声音」的能力。</p>',
      '</div>',

      '<div class="field">',
      '<div class="field-label">主要问题点 <span class="optional">只勾你确实看到的，勾不全没关系</span></div>',
      issuesHtml,
      '</div>',

      '<div class="field">',
      '<div class="field-label">拍摄条件 <span class="optional">便于以后按场景分开看指标</span></div>',
      '<div class="tag-groups">' + tagsHtml + '</div>',
      '</div>',

      '<details class="notes"><summary>备注（选填）</summary>',
      '<textarea id="notes" placeholder="例如：教练在旁边喊「拉」">' + esc(r.notes) + '</textarea>',
      '</details>',
    ].join('');

    wireForm();
  }

  function wireForm() {
    const r = row();
    if (!r) return;

    const actionSel = $('#actionSel');
    if (actionSel) {
      actionSel.addEventListener('change', () => {
        r.actionId = actionSel.value;
        if (r.actionId && r.actionId !== 'none') {
          const allowed = issuesOf(r.actionId).map(it => it.issueId);
          if (Array.isArray(r.issues)) {
            const kept = r.issues.filter(id => allowed.indexOf(id) >= 0);
            if (kept.length !== r.issues.length) {
              r.issues = kept.length ? kept : null;
              toast('已清空与新动作类型不匹配的问题点');
            }
          }
        } else {
          r.issues = null;
        }
        renderForm(); renderPanelHead(); renderList(); scheduleSave();
      });
    }

    const segStart = $('#segStart');
    if (segStart) segStart.addEventListener('click', setSegStart);
    const segEnd = $('#segEnd');
    if (segEnd) segEnd.addEventListener('click', setSegEnd);
    const segClear = $('#segClear');
    if (segClear) segClear.addEventListener('click', () => { r.segments = null; S.pendingStart = null; renderForm(); scheduleSave(); });
    const segNone = $('#segNone');
    if (segNone) segNone.addEventListener('change', () => { r.segments = segNone.checked ? 'none' : null; S.pendingStart = null; renderForm(); saveSoon(); });
    const segChips = $('#segChips');
    if (segChips) {
      segChips.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-del-seg]');
        if (!btn) return;
        const idx = Number(btn.dataset.delSeg);
        if (Array.isArray(r.segments)) { r.segments.splice(idx, 1); if (!r.segments.length) r.segments = null; renderForm(); scheduleSave(); }
      });
    }

    const voiceInputs = document.querySelectorAll('input[name="voice"]');
    voiceInputs.forEach(input => {
      input.addEventListener('change', () => {
        r.hasVoice = input.value === '' ? null : input.value === 'yes';
        renderForm(); scheduleSave();
      });
    });

    const issuesNone = $('#issuesNone');
    if (issuesNone) {
      issuesNone.addEventListener('change', () => {
        if (issuesNone.checked) { r.issues = 'none'; renderForm(); scheduleSave(); }
        else { r.issues = null; renderForm(); scheduleSave(); }
      });
    }

    document.querySelectorAll('#form input[data-issue]').forEach(input => {
      input.addEventListener('change', () => {
        const picked = Array.from(document.querySelectorAll('#form input[data-issue]:checked')).map(x => x.dataset.issue);
        r.issues = picked.length ? picked : null;
        renderForm(); scheduleSave();
      });
    });

    document.querySelectorAll('#form input[data-tag]').forEach(input => {
      input.addEventListener('change', () => {
        r.tags = Array.from(document.querySelectorAll('#form input[data-tag]:checked')).map(x => x.dataset.tag);
        renderForm(); scheduleSave();
      });
    });

    const notes = $('#notes');
    if (notes) notes.addEventListener('input', () => { r.notes = notes.value; scheduleSave(); });
  }

  // ─── 片段取时间 ──────────────────────────────────────────────
  function player() { return $('#player'); }

  function currentTime() {
    const v = player();
    return v && isFinite(v.currentTime) ? v.currentTime : null;
  }

  function setSegStart() {
    const r = row();
    if (!r || !r.fileExists) return;
    const t = currentTime();
    if (t == null) { toast('视频还没准备好，先播放一下', true); return; }
    S.pendingStart = t;
    renderForm();
  }

  function setSegEnd() {
    const r = row();
    if (!r || !r.fileExists) return;
    const t = currentTime();
    if (t == null) { toast('视频还没准备好，先播放一下', true); return; }
    if (S.pendingStart == null) { toast('先点「设起点」', true); return; }
    if (t <= S.pendingStart) { toast('终点要在起点之后', true); return; }
    const arr = Array.isArray(r.segments) ? r.segments.slice() : [];
    arr.push({ start: Math.round(S.pendingStart * 10) / 10, end: Math.round(t * 10) / 10 });
    arr.sort((a, b) => a.start - b.start);
    r.segments = arr;
    S.pendingStart = null;
    renderForm(); scheduleSave();
  }

  // ─── 保存 ────────────────────────────────────────────────────
  function saveSoon() {
    S.dirty = true;
    setStatus('有未保存的改动…');
    clearTimeout(S.timer);
    S.timer = setTimeout(save, 650);
  }
  const scheduleSave = saveSoon;

  async function save() {
    clearTimeout(S.timer);
    if (!S.data) return;
    if (S.saving) { S.queued = true; return; }
    S.saving = true;
    setStatus('保存中…');
    try {
      const res = await api('/api/save', { method: 'POST', body: JSON.stringify({ rows: rows() }) });
      // 注意：不要用 res.state 替换本地 rows —— 表单事件闭包持有的是当前行对象，
      // 替换后这些闭包会写到已被丢弃的对象上，后续编辑会静默丢失。
      S.data.savedAt = res.savedAt;
      S.dirty = false;
      setStatus('已保存 ' + fmtClock(res.savedAt), 'ok');
      if (res.warnings && res.warnings.length) showMessages('warn', ['已保存，但有提醒：'].concat(res.warnings));
      else hideMessages();
      renderList(); renderPanelHead();
    } catch (err) {
      setStatus('保存失败', 'err');
      const errs = (err.data && err.data.errors) || [err.message];
      showMessages('err', ['保存失败（文件没有被改动）'].concat(errs));
    } finally {
      S.saving = false;
      if (S.queued) { S.queued = false; saveSoon(); }
    }
  }

  // ─── 导航 ────────────────────────────────────────────────────
  function selectRow(i) {
    if (!rows()[i]) return;
    S.index = i;
    S.pendingStart = null;
    $('#empty').hidden = true;
    $('#panel').hidden = false;
    hideMessages();
    renderList(); renderPanelHead(); renderVideo(); renderForm();
  }

  function go(delta) {
    const v = visibleRows();
    const pos = v.findIndex(({ i }) => i === S.index);
    const next = pos < 0 ? v[0] : v[pos + delta];
    if (next) selectRow(next.i);
  }

  function goNextTodo() {
    const v = visibleRows().filter(({ r }) => !r.actionId);
    let pos = v.findIndex(({ i }) => i === S.index);
    const next = v[(pos + 1) % v.length];
    if (!next) { toast('已经没有未标注的视频了 🎉'); return; }
    selectRow(next.i);
  }

  function togglePlay() {
    const v = player();
    if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  }

  // ─── 添加视频 ────────────────────────────────────────────────
  async function openAddModal() {
    try {
      const res = await api('/api/state');
      S.data = res;
      renderList();
      // 重新载入后必须重新选中当前行，否则表单事件闭包仍指向旧的行对象
      if (rows().length) selectRow(Math.min(S.index, rows().length - 1));
      const items = res.unregistered || [];
      const box = $('#modalList');
      box.innerHTML = items.length
        ? items.map(it => '<div class="modal-item"><div class="modal-item-main"><div class="modal-item-name">' + esc(it.file) + '</div><div class="modal-item-sub">video_id：' + esc(it.suggestedId) + (it.sizeBytes ? ' · ' + fmtSize(it.sizeBytes) : '') + '</div></div><button class="btn btn-primary" data-add-file="' + esc(it.file) + '" type="button">添加</button></div>').join('')
        : '<div class="empty-note">没有可添加的视频。把视频文件放进 eval/videos/ 后，点右上角「刷新」。</div>';
      openModal();
    } catch (err) {
      toast(err.message, true);
    }
  }

  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-add-file]');
    if (!btn) return;
    try {
      const res = await api('/api/add', { method: 'POST', body: JSON.stringify({ file: btn.dataset.addFile }) });
      S.data = res.state;
      const idx = rows().findIndex(r => r.videoId === res.row.videoId);
      closeModal();
      renderList();
      if (idx >= 0) selectRow(idx);
      toast('已添加：' + res.row.videoId);
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ─── 顶栏按钮 ────────────────────────────────────────────────
  $('#btnSave').addEventListener('click', () => save());
  $('#btnValidate').addEventListener('click', async () => {
    try {
      const res = await api('/api/validate');
      if ((res.errors || []).length) showMessages('err', ['校验未通过：'].concat(res.errors));
      else if ((res.warnings || []).length) showMessages('warn', ['校验通过，但有提醒：'].concat(res.warnings));
      else showMessages('ok', ['校验通过，没有发现问题。']);
    } catch (err) {
      showMessages('err', [err.message]);
    }
  });
  $('#btnAdd').addEventListener('click', openAddModal);
  const btnRefresh = $('#btnRefresh');
  if (btnRefresh) btnRefresh.addEventListener('click', async () => {
    try { S.data = await api('/api/state'); renderList(); if (row()) selectRow(S.index); else renderVideo(); } catch (err) { toast(err.message, true); }
  });

  $('#btnPrev').addEventListener('click', () => go(-1));
  $('#btnNext').addEventListener('click', () => go(1));
  $('#btnNextTodo').addEventListener('click', goNextTodo);

  document.querySelectorAll('#filters .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      S.filter = chip.dataset.filter;
      const v = visibleRows();
      if (v.length && !v.some(({ i }) => i === S.index)) selectRow(v[0].i);
      else renderList();
    });
  });

  // ─── 快捷键 ──────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    // 弹窗打开时只处理 Esc，避免误触发下面的标注快捷键
    if (isModalOpen()) {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
      return;
    }
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 's' || e.key === 'S') { e.preventDefault(); setSegStart(); }
    else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); setSegEnd(); }
  });

  window.addEventListener('beforeunload', (e) => {
    if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ─── 启动 ────────────────────────────────────────────────────
  (async function boot() {
    try {
      S.data = await api('/api/state');
    } catch (err) {
      setStatus('载入失败', 'err');
      showMessages('err', ['载入失败：' + err.message, '请确认标注工具服务还在运行，然后刷新页面。']);
      return;
    }

    $('#brandSub').textContent = '标注文件：' + S.data.labelsFile + ' · 改动自动保存';

    if (S.data.loadErrors && S.data.loadErrors.length) {
      showMessages('err', ['标注文件里有一些问题（页面只显示了能解析的行）：'].concat(S.data.loadErrors));
    }

    renderList();
    const first = firstVisibleIndex();
    if (first >= 0) selectRow(first);
    else {
      $('#panel').hidden = true;
      $('#empty').hidden = false;
    }
    if (!S.data.progress || S.data.progress.total === 0) {
      $('#panel').hidden = true;
      $('#empty').hidden = false;
    }
    setStatus('已载入 ' + fmtClock(S.data.savedAt), 'ok');
  })();
})();
