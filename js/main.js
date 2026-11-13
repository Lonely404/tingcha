/**
 * main.js — 流程编排
 *
 * 只有这一层碰 DOM。引擎（engine.js）、匹配（matcher.js）、
 * 角色（lookshan.js）、语音（asr.js）、接口（api.js）都可以单独换掉。
 */

import { Engine, explainLocal, shareText } from './engine.js';
import { Kanzan, STATES, sleep } from './lookshan.js';
import { createRecognizer, isSupported as asrSupported } from './asr.js';
import { searchStories, explainSession } from './api.js';

// 模块一旦执行，就说明入口通了，启动守护不必再兜
window.__BOOT_OK__ = true;

const $ = (id) => document.getElementById(id);

const el = {
  chat: $('chat'),
  statScene: $('stat-scene'),
  statMiss: $('stat-miss'),
  kanzanBubble: $('kanzan-bubble'),
  kanzanArt: $('kanzan-art'),
  composer: $('composer'),
  input: $('input-text'),
  btnMic: $('btn-mic'),
  micLabel: $('mic-label'),
  btnSend: $('btn-send'),
  hint: $('input-hint'),
  startScreen: $('start-screen'),
  scenePicker: $('scene-picker'),
  capNote: $('capability-note'),
  reportScreen: $('report-screen'),
  btnRestart: $('btn-restart'),
  btnScenes: $('btn-scenes'),
  sceneMenu: $('scene-menu'),
  menuCurrent: $('menu-current'),
  menuList: $('scene-menu-list'),
  btnMenuClose: $('btn-menu-close'),
  btnMenuHome: $('btn-menu-home'),
};

let DATA = null;
let engine = null;
let kanzan = null;
let busy = false;
let recognizer = null;
let recording = false;
let sceneIndex = 0;
let idleLineShown = false;

/**
 * 每一段剧情都有一个令牌。开场 / 换场时令牌自增，
 * 旧流程在每个 await 之后发现令牌变了就自行退出——
 * 否则中途切场景后，旧的 await 会继续往对话区写台词，两套剧情叠在一起。
 */
let runSeq = 0;
/** 当前正在等玩家「继续」的那一次点击，空格键复用它 */
let pendingContinue = null;
/** 场景 id → 离开时停下的节点，切回来能接着走 */
const progress = new Map();
let inGame = false;

/* ---------------- 启动 ---------------- */

async function boot() {
  // scenes / phonetic 是必需品；lines / fallback 缺了可以降级，不该整站挂掉
  let scenes, phonetic, lines, fallback;
  try {
    [scenes, phonetic] = await Promise.all([
      fetchJson('./data/scenes.json'),
      fetchJson('./data/phonetic-map.json'),
    ]);
  } catch (err) {
    console.error('[听岔] 剧本数据加载失败', err);
    window.__bootFail__?.('module', `剧本数据加载失败：${err.message}\n检查 data/scenes.json 与 data/phonetic-map.json 是否可访问。`);
    return;
  }

  [lines, fallback] = await Promise.all([
    fetchJson('./data/lines.json').catch((e) => {
      console.warn('[听岔] 台词库缺失，刘看山将保持沉默', e);
      return { idle: [], correct: [], mishear: {}, reportOpen: [] };
    }),
    fetchJson('./data/fallback.json').catch((e) => {
      console.warn('[听岔] 降级池缺失，接口失败时无可展示内容', e);
      return { explainTemplate: {}, stories: [], emptySearch: {} };
    }),
  ]);

  DATA = { scenes, phonetic, lines, fallback };

  engine = new Engine({ scenes: DATA.scenes, phonetic: DATA.phonetic, lines: DATA.lines });
  kanzan = new Kanzan({
    artEl: el.kanzanArt,
    bubbleEl: el.kanzanBubble,
    lines: DATA.lines,
  });

  renderScenePicker();
  setupComposer();
  setupKeyboard();
  el.btnScenes.addEventListener('click', openSceneMenu);
  el.btnMenuClose.addEventListener('click', closeSceneMenu);
  el.btnMenuHome.addEventListener('click', exitToStart);
  el.sceneMenu.addEventListener('click', (e) => {
    if (e.target === el.sceneMenu) closeSceneMenu(); // 点遮罩空白处也能关
  });
  el.btnRestart.addEventListener('click', () => location.reload());
  el.reportScreen.querySelector('#btn-again')?.addEventListener('click', () => location.reload());
  el.reportScreen.querySelector('#btn-share')?.addEventListener('click', onShare);

  // 调试/演示入口：?scene=cha-chaan-teng 直接进场，省得每次点。做 PPT 截图和路演预演都用它。
  const wanted = new URLSearchParams(location.search).get('scene');
  if (wanted) {
    const idx = engine.sceneList.findIndex((s) => s.id === wanted);
    if (idx >= 0) {
      el.startScreen.classList.add('hidden');
      startScene(idx);
    }
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(url + ' ' + res.status);
  return res.json();
}

/* ---------------- 开始页 ---------------- */

function renderScenePicker() {
  const list = engine.sceneList;
  el.scenePicker.innerHTML = '';
  list.forEach((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'scene-card';
    b.innerHTML = `<div><div class="t">${s.title}</div><div class="s">${s.subtitle || ''}</div></div><div class="arrow">→</div>`;
    b.addEventListener('click', () => {
      sceneIndex = i;
      el.startScreen.classList.add('hidden');
      startScene(i);
    });
    el.scenePicker.appendChild(b);
  });

  el.capNote.textContent = asrSupported()
    ? '这个浏览器支持语音识别。麦克风被拒绝也没关系，输入框随时可以打字。'
    : '这个浏览器不支持语音识别，已自动切到打字模式——玩法完整，只是少了那一口音。建议用 Chrome 或 Edge 打开。';

  el.scenePicker.setAttribute('aria-busy', 'false');
}

/* ---------------- 场景流程 ---------------- */

async function startScene(i, { keepLog = false, resume = false } = {}) {
  const myRun = ++runSeq;          // 作废上一段剧情的所有待续流程
  sceneIndex = i;
  inGame = true;
  idleLineShown = false;
  kanzan.setState(STATES.IDLE);
  kanzan.clear();

  const sceneId = engine.sceneList[i].id;
  if (!keepLog) progress.clear();  // 全新一局，之前的续点作废
  let node = engine.start(sceneId, { keepLog });

  // 从别处切回来时，回到离开的那一步，而不是重头念一遍
  if (resume) {
    const saved = progress.get(sceneId);
    if (saved && engine.scene.nodes[saved]) node = engine.goTo(saved);
  }

  updateHud();
  await renderNode(node, myRun);
}

function updateHud() {
  el.statScene.textContent = `场景 ${sceneIndex + 1}/${engine.sceneList.length}`;
  el.statMiss.innerHTML = `说岔 <b>${engine.mistakes}</b> 次`;
}

async function renderNode(node, myRun) {
  if (!node || myRun !== runSeq) return;

  if (node.type === 'narrate') {
    pushMsg(node.npc && node.npc !== '旁白' ? node.npc : null, node.text, node.npc === '旁白' ? 'narrator' : '');

    // 事故节点：先演出后果，再让刘看山探头讲解
    if (node.explain) {
      await sleep(420);
      if (myRun !== runSeq) return;
      const lines = DATA.lines.mishear?.[node.explain] || [];
      const rest = lines.slice(1);
      if (rest.length) {
        kanzan.setState(STATES.EXPLAIN);
        pushMsg('刘看山', rest.join('\n\n'), 'kanzan');
      }
    }

    setComposerEnabled(false);
    await waitContinue(node.next ? '继续' : '看报告');
    if (myRun !== runSeq) return;    // 等待期间被换场了，这里不再往下走
    if (node.next) {
      const next = engine.goTo(node.next);
      updateHud();
      return renderNode(next, myRun);
    }
    return showReport();
  }

  if (node.type === 'speak') {
    pushMsg(node.npc, node.npcLine, '');
    kanzan.setState(STATES.IDLE);
    // 说话前最多一句「试试看」，绝不给发音提示；之后保持安静
    if (!idleLineShown) {
      idleLineShown = true;
      await kanzan.say(kanzan.pick('idle'));
      if (myRun !== runSeq) return;
    } else {
      kanzan.clear();
    }
    setHint(node.prompt || '');
    el.input.value = '';
    setComposerEnabled(true);
    el.input.focus();
    return;
  }

  if (node.type === 'ending') {
    pushMsg(null, node.text, 'narrator');
    setComposerEnabled(false);
    const hasNext = sceneIndex + 1 < engine.sceneList.length;
    await waitContinue(hasNext ? `下一场景 · ${engine.sceneList[sceneIndex + 1].title}` : '看听岔报告');
    if (myRun !== runSeq) return;
    progress.delete(engine.scene.id); // 这一幕已经走完，别再续到结局里去
    if (hasNext) {
      el.chat.innerHTML = '';
      kanzan.clear();
      return startScene(sceneIndex + 1, { keepLog: true });
    }
    return showReport();
  }
}

/* ---------------- 玩家开口 ---------------- */

async function submit(text, opts = {}) {
  if (busy) return;
  const node = engine.node();
  if (!node || node.type !== 'speak') return;
  const raw = String(text || '').trim();
  if (!raw) return;

  const myRun = runSeq;             // 换场后这段判定就作废
  busy = true;
  setComposerEnabled(false);
  setHint('');
  el.input.value = '';

  // try/finally：剧本数据被改坏（跳转到不存在的节点）时，busy 必须复位，
  // 否则整个输入区永久锁死，玩家只能刷新——演示现场等于事故。
  try {
    const turn = engine.speak(raw, opts);
    pushMsg('你', turn.via === 'asr' ? `（说）${raw}` : raw, 'me', turn.via === 'asr' ? `识别为：${raw}` : null);
    updateHud();

    if (turn.outcome === 'mishear') {
      kanzan.setState(STATES.HEADTILT);
      const line = (DATA.lines.mishear?.[turn.lineId] || [])[0];
      await kanzan.say(line || '……等一下。');
      await sleep(700);
      if (myRun !== runSeq) return;
    } else if (turn.outcome === 'correct') {
      kanzan.setState(STATES.IDLE);
      kanzan.say(kanzan.pick('correct'));
    } else {
      kanzan.setState(STATES.HEADTILT);
      kanzan.say('……他没听懂。');
      await sleep(400);
      if (myRun !== runSeq) return;
    }

    await renderNode(engine.node(), myRun);
  } catch (err) {
    console.error('[听岔] 剧情推进失败', err);
    setHint(`这一步卡住了：${err.message}。按右上角「重来」可以继续。`, 'warn');
  } finally {
    busy = false;
  }
}

/* ---------------- 输入区 ---------------- */

function setupComposer() {
  el.btnSend.addEventListener('click', () => submit(el.input.value, { via: 'typing' }));
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit(el.input.value, { via: 'typing' });
  });
  el.input.addEventListener('input', syncSendState);

  if (!asrSupported()) {
    el.btnMic.disabled = true;
    el.micLabel.textContent = '打字模式';
    return;
  }

  el.btnMic.addEventListener('click', () => (recording ? stopRec() : startRec()));
}

function startRec() {
  if (busy || engine.node()?.type !== 'speak') return;
  recognizer = createRecognizer({
    lang: 'zh-HK',
    onInterim: (t) => { el.input.value = t; },
    onFinal: (r) => {
      endRecUI();
      submit(r.text, { via: 'asr', heardRaw: r.text });
    },
    onError: (err) => {
      endRecUI();
      if (err.code === 'aborted') return;
      setHint(`语音没走通（${err.message}），直接打字也算——打字一样会岔。`, 'warn');
      el.input.focus();
    },
  });
  if (!recognizer) return;
  recording = true;
  el.btnMic.classList.add('recording');
  el.micLabel.textContent = '听着…';
  setHint('说完停一下，识别出来的原文会直接进剧情。');
  recognizer.start();
}

function stopRec() {
  recognizer?.stop();
  endRecUI();
}

function endRecUI() {
  recording = false;
  el.btnMic.classList.remove('recording');
  el.micLabel.textContent = '说话';
}

function setComposerEnabled(on) {
  el.composer.dataset.mode = on ? 'ready' : 'idle';
  syncSendState();
  if (!on && recording) stopRec();
}

/** 发送键可用性只由「输入区是否就绪 + 有无内容」决定，
 *  否则旁白阶段随便敲几个字就会把按钮点亮，点了却没反应。 */
function syncSendState() {
  const ready = el.composer.dataset.mode === 'ready';
  el.btnSend.disabled = !ready || !el.input.value.trim();
}

function setHint(text, cls = '') {
  el.hint.textContent = text || '';
  el.hint.className = 'composer-hint' + (cls ? ' ' + cls : '');
}

/* ---------------- 对话渲染 ---------------- */

function pushMsg(who, text, variant = '', note = null) {
  const div = document.createElement('div');
  div.className = 'msg' + (variant ? ' ' + variant : '');
  if (variant === 'me') div.classList.add('me');

  if (who) {
    const w = document.createElement('div');
    w.className = 'who';
    w.textContent = who;
    div.appendChild(w);
  }

  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  div.appendChild(b);

  if (note) {
    const n = document.createElement('div');
    n.className = 'note';
    n.textContent = note;
    div.appendChild(n);
  }

  el.chat.appendChild(div);
  scrollChat();
  return div;
}

/** 滚到底：用 rAF 合帧，连续 push 多条消息时不会排队卡顿 */
let scrollTick = false;
function scrollChat() {
  if (scrollTick) return;
  scrollTick = true;
  requestAnimationFrame(() => {
    scrollTick = false;
    const wrap = el.chat.parentElement;
    wrap.scrollTop = wrap.scrollHeight;
  });
}

/**
 * 等待玩家「继续」，返回一个可 await 的 promise。
 * 三种触发方式共用同一次 resolve：点按钮、按空格/回车（见 onKeydown）、被换场作废（cancel）。
 */
function waitContinue(label) {
  return new Promise((resolve) => {
    const holder = document.createElement('div');
    holder.className = 'msg narrator';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost continue';
    btn.innerHTML = `<span>${esc(label)} →</span><kbd>空格</kbd>`;

    let done = false;
    const settle = () => {
      if (done) return;               // 防连点：连点两次会跳过一整段剧情
      done = true;
      if (pendingContinue && pendingContinue.fire === settle) pendingContinue = null;
      btn.disabled = true;
      holder.remove();
      resolve();
    };

    btn.addEventListener('click', settle);
    holder.appendChild(btn);
    el.chat.appendChild(holder);
    scrollChat();
    btn.focus({ preventScroll: true });  // 键盘可及：焦点在这儿，空格/回车天然可用

    pendingContinue = { fire: settle, cancel: settle };
  });
}

/* ---------------- 键盘 ---------------- */

const isTypingTarget = (t) =>
  !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

const sceneMenuOpen = () => !el.sceneMenu.classList.contains('hidden');
const startOpen = () => !el.startScreen.classList.contains('hidden');
const reportOpen = () => !el.reportScreen.classList.contains('hidden');

function setupKeyboard() {
  document.addEventListener('keydown', onKeydown);
}

function onKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return; // 输入法组词中，不抢键

  // Esc：随时打开/收起换场景面板（在输入框里也生效，这是「随时退出」的快捷入口）
  if (e.key === 'Escape') {
    if (sceneMenuOpen()) {
      e.preventDefault();
      closeSceneMenu();
      return;
    }
    if (startOpen() || reportOpen()) return;
    e.preventDefault();
    el.input.blur();
    openSceneMenu();
    return;
  }

  if (isTypingTarget(e.target)) return; // 打字时，空格就是空格

  if (sceneMenuOpen()) return;          // 面板开着，按键交给面板里的按钮

  if (startOpen()) {
    // 1/2/3 直接进场；空格/回车留给卡片按钮的原生行为，免得和点击抢
    if (/^[1-9]$/.test(e.key)) {
      const i = Number(e.key) - 1;
      if (i < engine.sceneList.length) {
        e.preventDefault();
        el.startScreen.classList.add('hidden');
        startScene(i);
      }
    }
    return;
  }

  if (reportOpen()) return;

  const isSpace = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
  const isEnter = e.key === 'Enter';
  if (!isSpace && !isEnter) return;
  if (e.repeat) return;                 // 长按空格不连跳

  if (pendingContinue) {
    e.preventDefault();                 // 拦住页面滚动和按钮的原生激活，只走一次
    pendingContinue.fire();
  }
}

/* ---------------- 场景切换 ---------------- */

function openSceneMenu() {
  if (!inGame || startOpen() || reportOpen()) return;
  renderSceneMenu();
  el.sceneMenu.classList.remove('hidden');
  el.menuList.querySelector('.scene-card.current')?.focus({ preventScroll: true });
}

function closeSceneMenu() {
  el.sceneMenu.classList.add('hidden');
}

function renderSceneMenu() {
  el.menuCurrent.textContent = engine.scene?.title || '—';
  el.menuList.innerHTML = '';
  engine.sceneList.forEach((s, i) => {
    const cur = i === sceneIndex;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'scene-card' + (cur ? ' current' : '');
    b.innerHTML = `<div><div class="t">${esc(s.title)}</div><div class="s">${esc(s.subtitle || '')}</div></div><div class="arrow">${cur ? '当前' : '→'}</div>`;
    b.addEventListener('click', () => switchScene(i));
    el.menuList.appendChild(b);
  });
}

/** 让当前这段剧情立刻作废：令牌自增 + 解开「继续」的等待 + 收掉正在录的音 */
function abortRun() {
  runSeq += 1;
  pendingContinue?.cancel();
  pendingContinue = null;
  busy = false;
  if (recording) stopRec();
  setComposerEnabled(false);
  setHint('');
}

function saveProgress() {
  if (engine?.scene && engine.nodeId) progress.set(engine.scene.id, engine.nodeId);
}

async function switchScene(i) {
  closeSceneMenu();
  if (i === sceneIndex) return;  // 点的就是当前场景，等于「回到当前场景」
  saveProgress();
  abortRun();
  el.chat.innerHTML = '';
  kanzan.clear();
  await startScene(i, { keepLog: true, resume: true });
}

function exitToStart() {
  closeSceneMenu();
  abortRun();
  progress.clear();
  el.chat.innerHTML = '';
  kanzan.clear();
  kanzan.setState(STATES.IDLE);
  inGame = false;
  sceneIndex = 0;
  engine.start(engine.sceneList[0].id);  // 回到开始页等于这一局结束，清空战绩
  el.statScene.textContent = `场景 —/${engine.sceneList.length}`;
  el.statMiss.innerHTML = '说岔 <b>0</b> 次';
  el.startScreen.classList.remove('hidden');
}

/* ---------------- 报告页 ---------------- */

async function showReport() {
  setComposerEnabled(false);
  const report = engine.report();
  kanzan.setState(STATES.REPORT);
  const open = DATA.lines.reportOpen || [];
  pushMsg('刘看山', open.join('\n'), 'kanzan');

  el.reportScreen.classList.remove('hidden');
  el.reportScreen.querySelector('#report-title').innerHTML =
    report.mistakes.length
      ? `这一局你岔了 <em>${report.mistakes.length}</em> 次`
      : '这一局你一句都没被听岔';

  renderPairs(report);

  // 先把本地内容铺上（零等待），接口回来再回填。
  // 原来是串行 await 直答 + 搜索，最坏要干等 8 秒才看到报告。
  const explainBox = el.reportScreen.querySelector('#report-explain');
  const explainTag = el.reportScreen.querySelector('#report-explain-src');
  const local = explainLocal(report, DATA.fallback.explainTemplate);
  explainBox.textContent = local;
  explainTag.className = 'src-tag';
  explainTag.textContent = '正在向知乎直答请求个性化解析…';

  const storiesBox = el.reportScreen.querySelector('#report-stories');
  const storiesTag = el.reportScreen.querySelector('#report-stories-src');
  storiesBox.innerHTML = '';
  renderStoryList(storiesBox, DATA.fallback.stories || []);
  storiesTag.className = 'src-tag';
  storiesTag.textContent = '预存记录 · 正在检索同类真实事故…';

  // 两个请求并行，谁回来谁回填，互不阻塞
  // 一句都没岔时不调直答：全局额度 100 次/天，是整条链路最紧的一环，
  // 拿它去生成一句「你没岔」纯属浪费。
  if (report.mistakes.length) {
    loadExplain(report, local, explainBox, explainTag);
  } else {
    explainTag.className = 'src-tag';
    explainTag.textContent = '这一局没有可解析的词对，未消耗直答额度。';
  }
  loadStories(report, storiesBox, storiesTag);
}

function renderPairs(report) {
  const box = el.reportScreen.querySelector('#report-pairs');
  box.innerHTML = '';
  if (!report.mistakes.length) {
    box.innerHTML = '<div class="pair empty">一句都没岔。要么你说得太准，要么你说的都是最保险的那句。</div>';
    return;
  }
  for (const m of report.mistakes) {
    const d = document.createElement('div');
    d.className = 'pair';
    d.innerHTML = `
      <div class="row"><span class="k">你想说</span><span class="v">${esc(m.expected)}</span></div>
      <div class="row"><span class="k">对方听到</span><span class="v bad">${esc(m.label || m.heard)}</span></div>
      ${m.note ? `<div class="why">${esc(m.note)}</div>` : ''}`;
    box.appendChild(d);
  }
}

/** 直答回填：不阻塞报告渲染 */
async function loadExplain(report, local, box, tag) {
  const res = await explainSession(
    {
      mistakes: report.mistakes.map((m) => ({ expected: m.expected, heard: m.label || m.heard })),
      turns: report.totalTurns,
    },
    local
  );
  box.textContent = res.data;
  if (res.notice) {
    tag.className = 'src-tag';
    tag.textContent = res.notice;
  } else {
    tag.className = 'src-tag live';
    tag.textContent = '由知乎直答生成';
  }
}

/** 搜索回填：不阻塞报告渲染 */
async function loadStories(report, box, tag) {
  // 宽语义查询：窄词对检索召回差，实测过
  const query = report.mistakes.length ? '粤语 听错 闹笑话 尴尬经历' : '粤语 发音 误会 经历';
  const res = await searchStories(query, DATA.fallback);

  const items = Array.isArray(res.data) ? res.data : [];
  if (!items.length) {
    box.innerHTML = `<div class="story"><div class="sx">${esc(DATA.fallback.emptySearch?.notice || '暂时没有搜到同类事故。')}</div></div>`;
  } else {
    renderStoryList(box, items);
  }

  if (res.notice) {
    tag.className = 'src-tag';
    tag.textContent = res.notice;
  } else {
    tag.className = 'src-tag live';
    tag.textContent = `来自知乎搜索 · ${items.length} 条`;
  }
}

function renderStoryList(box, items) {
  box.innerHTML = '';
  for (const it of items) {
    const d = document.createElement('div');
    d.className = 'story';
    d.innerHTML = `
      <div class="st">${esc(it.title || '未命名')}</div>
      <div class="sx">${esc(it.excerpt || '')}</div>
      ${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">查看原帖 ↗</a>` : ''}`;
    box.appendChild(d);
  }
}

async function onShare() {
  const text = shareText(engine.report());
  try {
    await navigator.clipboard.writeText(text);
    flash(el.reportScreen.querySelector('#btn-share'), '已复制');
  } catch {
    window.prompt('复制这段：', text);
  }
}

function flash(btn, txt) {
  if (!btn) return;
  const old = btn.textContent;
  btn.textContent = txt;
  setTimeout(() => (btn.textContent = old), 1400);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot().catch((err) => {
  console.error('[听岔] 启动失败', err);
  window.__bootFail__?.('module', `启动失败：${err?.message || err}`);
});
