#!/usr/bin/env node
/**
 * test-engine.mjs — 引擎自测（不开浏览器）
 *
 * 跑：node tools/test-engine.mjs
 *
 * 覆盖四件必须保证的事：
 *   1. 说对 -> 正确分支
 *   2. 说岔 -> 事故分支，且报告里记下词对
 *   3. 说了一堆没人认识的 -> onFallback，不许崩、不许卡死
 *   4. 台词库不会在玩家开口前泄露发音提示
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, explainLocal, shareText } from '../js/engine.js';
import { matchHeard } from '../js/matcher.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));

const scenes = read('data/scenes.json');
const phonetic = read('data/phonetic-map.json');
const lines = read('data/lines.json');

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { fail++; console.log(`  \x1b[31m×\x1b[0m ${msg}`); }
};

/* ---------- 1. 匹配层 ---------- */
console.log('\n匹配层');
ok(matchHeard(phonetic['ning-cha'], '冻柠茶').outcome === 'correct', '完全匹配正确词');
ok(matchHeard(phonetic['ning-cha'], '凍檸茶').outcome === 'correct', '繁体别名也算正确');
ok(matchHeard(phonetic['ning-cha'], '冻零茶').outcome === 'mishear', '完全匹配误听词');
ok(matchHeard(phonetic['ning-cha'], '冻 零 茶。').outcome === 'mishear', '标点空格不影响判定');
ok(matchHeard(phonetic['ning-cha'], '嗯那个我要一杯冻零茶谢谢').outcome === 'mishear', '长句里包含误听词，最长别名优先');
ok(matchHeard(phonetic['ning-cha'], '完全无关的一句话').outcome === 'unknown', '完全无关 -> unknown');
ok(matchHeard(phonetic['ning-cha'], '').outcome === 'empty', '空输入 -> empty');
ok(matchHeard(phonetic['ning-cha'], '冻柠茶少甜').outcome === 'correct', '带修饰语的正确句仍判正确');

/* ---------- 2. 剧情流程 ---------- */

/** 自动打通一个场景：遇到旁白就顺着 next 走，遇到 speak 就按 say 策略开口 */
function autoPlay(sceneId, chooseSay) {
  const e = new Engine({ scenes, phonetic, lines });
  e.start(sceneId);
  const said = [];
  let guard = 0;
  while (guard++ < 30) {
    const n = e.node();
    if (!n || n.type === 'ending') break;
    if (n.type === 'narrate') { e.goTo(n.next); continue; }
    if (n.type === 'speak') {
      const turn = e.speak(chooseSay(n), { via: 'asr' });
      said.push(turn);
      continue;
    }
    throw new Error('未知节点类型 ' + n.type);
  }
  return { engine: e, said, finished: e.node()?.type === 'ending' };
}

console.log('\n剧情流程（茶餐厅 · 全程说对）');
{
  const { engine: e, said, finished } = autoPlay('cha-chaan-teng', (n) => phonetic[n.expect].correct[0]);
  ok(said.length === 2, `经过 ${said.length} 个开口节点`);
  said.forEach((t) => ok(t.outcome === 'correct', `「${t.expected}」判为正确，进入 ${t.nextNodeId}`));
  ok(finished, '走到结局节点');
  ok(e.report().mistakes.length === 0, '报告里 0 次说岔');
}

console.log('\n剧情流程（茶餐厅 · 全程说岔）');
{
  const { engine: e, said, finished } = autoPlay('cha-chaan-teng', (n) => phonetic[n.expect].mishears[0].heard[0]);
  said.forEach((t) => {
    ok(t.outcome === 'mishear', `「${t.expected}」被听成「${t.label}」`);
    ok(!!e.scene.nodes[t.nextNodeId].explain, `事故节点 ${t.nextNodeId} 带讲解`);
  });
  ok(finished, '说岔也能走到结局');
  const r = e.report();
  ok(r.mistakes.length === 2, `报告记下了 ${r.mistakes.length} 组词对`);
  ok(r.mistakes.every((m) => m.note && m.label), '每组词对都带 label 和解释');
  const text = explainLocal(r, read('data/fallback.json').explainTemplate);
  ok(text.includes(r.mistakes[0].expected) && text.length > 60, '离线解析文案能生成');
  console.log('    \x1b[2m—— 离线解析预览 ——\x1b[0m');
  console.log('    ' + text.split('\n\n')[1].replace(/\n/g, '\n    '));
}

console.log('\n剧情流程（乱说话 · 走兜底）');
{
  const { engine: e, said, finished } = autoPlay('convenience-store', () => '啊这个那个我忘了怎么说');
  ok(said.every((t) => t.outcome === 'unknown'), '陌生输入判为 unknown，走 onFallback');
  ok(finished, '兜底路径也能走到结局，不会断线');
  ok(e.turns.every((t) => t.nextNodeId), '每次开口都有下一节点，没有断线');
}

console.log('\n三个场景都能开场');
for (const s of scenes.scenes) {
  const e = new Engine({ scenes, phonetic, lines });
  const n = e.start(s.id);
  ok(!!n, `${s.title} 能开场（首节点 ${n.type}）`);
}

/* ---------- 2.5 词表里每一条误听都必须真的能触发 ---------- */
console.log('\n每条误听都可达');
for (const [key, entry] of Object.entries(phonetic)) {
  if (key.startsWith('_')) continue;
  for (const m of entry.mishears || []) {
    for (const h of [m.label, ...(m.heard || [])]) {
      const r = matchHeard(entry, h);
      ok(
        r.outcome === 'mishear' && r.mishear.id === m.id,
        `${key}: 「${h}」→ ${m.id}${r.outcome === 'correct' ? '（被 correct 抢走了）' : ''}`
      );
    }
  }
}

/* ---------- 2.6 跨场景连玩：战绩不许被重置 ---------- */
console.log('\n跨场景连玩');
{
  const e = new Engine({ scenes, phonetic, lines });
  e.start('cha-chaan-teng');
  e.goTo('order'); // entry 是旁白，先走到第一个开口节点
  e.speak(phonetic['ning-cha'].mishears[0].heard[0]);
  e.goTo('bill');
  e.speak(phonetic['maai-daan'].mishears[0].heard[0]);
  ok(e.report().mistakes.length === 2, '第一关记下 2 组词对');

  e.start('convenience-store', { keepLog: true });
  ok(e.report().mistakes.length === 2, 'keepLog 进入第二关后，战绩仍然保留');
  ok(e.report().totalTurns === 2, 'totalTurns 跟着累计');

  e.start('asking-way');
  ok(e.report().mistakes.length === 0, '不传 keepLog 时按新一局清零');
}

/* ---------- 2.7 分享文案 ---------- */
console.log('\n分享文案');
{
  const twoOfFive = shareText({
    mistakes: [{ expected: '唔该，一杯冻柠茶', label: '冻零茶' }],
    totalTurns: 5,
  });
  ok(twoOfFive.includes('5 句') && twoOfFive.includes('1 次'), `说岔占比用总句数：${twoOfFive}`);
  const none = shareText({ mistakes: [], totalTurns: 4 });
  ok(none.includes('4 句'), '一句没岔时也能说清说了几句');
}

/* ---------- 3. 台词约束 ---------- */
console.log('\n台词约束');
{
  const bad = ['发音', '声调', '声母', '韵母', '注意', '读成', '正确读音', '懒音'];
  const idleViolation = lines.idle.filter((t) => bad.some((w) => t.includes(w)));
  ok(idleViolation.length === 0, '待机台词不含任何发音提示');
  const correctViolation = lines.correct.filter((t) => bad.some((w) => t.includes(w)));
  ok(correctViolation.length === 0, '答对后的台词也不含提示（避免暗示下一句怎么读）');
}

/* ---------- 汇总 ---------- */
console.log(`\n${fail === 0 ? '\x1b[32m全部通过\x1b[0m' : '\x1b[31m有失败\x1b[0m'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
