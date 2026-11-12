#!/usr/bin/env node
/**
 * lint-data.mjs — 剧本数据校验
 *
 * 跑：node tools/lint-data.mjs
 *
 * 电信A 每天都会改 scenes.json 和 lines.json，改坏的可能性比写代码还高。
 * 这个脚本把「改坏了」这件事变成一条命令能查出来的事：
 *   1. 所有跳转目标必须存在
 *   2. 每个 speak 节点的 expect 必须在音近词表里，且 onMishear 的 key 必须对得上
 *   3. 每个 mishear 的 lineId 必须在台词库里
 *   4. 待机台词不许出现发音提示（核心设计约束）
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { norm } from '../js/matcher.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));

const scenes = read('data/scenes.json');
const phonetic = read('data/phonetic-map.json');
const lines = read('data/lines.json');

const errors = [];
const warns = [];
const ERR = (m) => errors.push(m);
const WARN = (m) => warns.push(m);

/* ---------- 1. 音近词表自身 ---------- */
for (const [key, entry] of Object.entries(phonetic)) {
  if (key.startsWith('_')) continue;
  if (!entry.canonical) ERR(`音近词表 ${key}: 缺 canonical`);
  if (!Array.isArray(entry.correct) || !entry.correct.length) WARN(`音近词表 ${key}: correct 为空，永远匹配不到正确分支`);

  // 同一个字符串既在 correct 又在某条 mishear 里 → 精确匹配先命中 correct，
  // 那条误听分支永远走不到，等于剧本里有一段死线。
  const correctSet = new Set((entry.correct || []).map(norm).filter(Boolean));
  const aliasOwner = new Map();

  const ids = new Set();
  for (const m of entry.mishears || []) {
    if (!m.id) ERR(`音近词表 ${key}: 有 mishear 缺 id`);
    if (ids.has(m.id)) ERR(`音近词表 ${key}: mishear id 重复 "${m.id}"`);
    ids.add(m.id);
    if (!m.lineId) ERR(`音近词表 ${key}/${m.id}: 缺 lineId`);
    else if (!lines.mishear?.[m.lineId]) ERR(`音近词表 ${key}/${m.id}: lineId "${m.lineId}" 在台词库里不存在`);
    if (m.verified === false) WARN(`音近词表 ${key}/${m.id}: 尚未实测（verified=false）`);

    for (const raw of [m.label, ...(m.heard || [])]) {
      const a = norm(raw);
      if (!a) continue;
      if (correctSet.has(a)) {
        ERR(`音近词表 ${key}/${m.id}: 「${raw}」同时写在 correct 里，误听分支永远触发不了`);
      }
      if (aliasOwner.has(a) && aliasOwner.get(a) !== m.id) {
        ERR(`音近词表 ${key}: 「${raw}」同时属于两条误听 ${aliasOwner.get(a)} / ${m.id}，归属不确定`);
      }
      aliasOwner.set(a, m.id);
    }
  }
}

/* ---------- 2. 剧情图 ---------- */
const forbiddenWords = lines._meta?.forbiddenInIdle || ['发音', '声调'];
const speakExpects = new Set();
for (const scene of scenes.scenes) {
  const ids = Object.keys(scene.nodes);
  const check = (target, from) => {
    if (!target) return;
    if (!scene.nodes[target]) ERR(`[${scene.id}] 节点 ${from} 跳转到不存在的 ${target}`);
  };

  if (!scene.nodes[scene.entry]) ERR(`[${scene.id}] entry "${scene.entry}" 不存在`);

  let speakNodes = 0;
  for (const [id, n] of Object.entries(scene.nodes)) {
    check(n.next, id);

    // 旁白没有 next 会直接跳报告页，玩家会以为游戏坏了
    if (n.type === 'narrate' && !n.next) {
      ERR(`[${scene.id}] 旁白节点 ${id} 缺 next，剧情会中途跳到报告页`);
    }

    if (n.type === 'speak') {
      speakNodes++;
      if (!n.expect) ERR(`[${scene.id}] speak 节点 ${id} 缺 expect`);
      else if (!phonetic[n.expect]) ERR(`[${scene.id}] speak 节点 ${id} 的 expect "${n.expect}" 在音近词表里不存在`);
      else speakExpects.add(n.expect);

      check(n.onCorrect, id + '.onCorrect');
      check(n.onFallback, id + '.onFallback');
      if (!n.onCorrect) ERR(`[${scene.id}] speak 节点 ${id} 缺 onCorrect`);
      if (!n.onFallback) WARN(`[${scene.id}] speak 节点 ${id} 缺 onFallback，识别失败会断线`);

      // 产品红线：开口前的提示语也不许教发音
      const leak = forbiddenWords.find((w) => (n.prompt || '').includes(w));
      if (leak) {
        ERR(`[${scene.id}] speak 节点 ${id} 的 prompt 出现发音提示「${leak}」—— 玩家会照着念，说岔就演不出来了`);
      }

      const entry = phonetic[n.expect];
      const validIds = new Set((entry?.mishears || []).map((m) => m.id));
      for (const [mid, target] of Object.entries(n.onMishear || {})) {
        check(target, `${id}.onMishear.${mid}`);
        if (!validIds.has(mid)) ERR(`[${scene.id}] 节点 ${id} 的 onMishear 里有 "${mid}"，但词表 ${n.expect} 没这一项`);
      }
      // 反向：词表里有、剧情没接的误听，会静默掉到 onFallback
      for (const m of entry?.mishears || []) {
        if (!n.onMishear?.[m.id]) WARN(`[${scene.id}] 节点 ${id}: 词表误听 "${m.id}" 没有对应剧情，会掉到 onFallback`);
      }
    }

    if (n.explain && !lines.mishear?.[n.explain]) {
      ERR(`[${scene.id}] 节点 ${id} 的 explain "${n.explain}" 在台词库里不存在`);
    }
  }

  if (speakNodes < 2) WARN(`[${scene.id}] 只有 ${speakNodes} 个开口节点，游戏时长可能不到 1 分钟`);
  const reachable = new Set([scene.entry]);
  const queue = [scene.entry];
  while (queue.length) {
    const cur = scene.nodes[queue.shift()];
    const outs = [cur.next, cur.onCorrect, cur.onFallback, ...Object.values(cur.onMishear || {})].filter(Boolean);
    for (const o of outs) if (!reachable.has(o)) { reachable.add(o); queue.push(o); }
  }
  const orphan = ids.filter((i) => !reachable.has(i));
  if (orphan.length) WARN(`[${scene.id}] 不可达节点：${orphan.join(', ')}`);
}

/* ---------- 3. 台词库 ---------- */
const forbidden = forbiddenWords;
for (const [bucket, arr] of [['idle', lines.idle], ['correct', lines.correct]]) {
  for (const t of arr || []) {
    const hit = forbidden.find((w) => t.includes(w));
    if (hit) ERR(`台词库 ${bucket} 里有发音提示「${hit}」：「${t}」—— 这一句会让核心机制当场失效`);
  }
}
for (const [k, arr] of Object.entries(lines.mishear || {})) {
  if (!Array.isArray(arr) || !arr.length) ERR(`台词库 mishear.${k} 为空`);
  else if (arr.length < 2) WARN(`台词库 mishear.${k} 只有 ${arr.length} 句，讲解会显得单薄`);
}

/* ---------- 4. 词表里没被任何剧情用到的条目 ---------- */
for (const key of Object.keys(phonetic)) {
  if (key.startsWith('_')) continue;
  if (!speakExpects.has(key)) WARN(`音近词表 ${key} 没有任何剧情节点在用（可能是留作后续关卡）`);
}

/* ---------- 输出 ---------- */
const c = { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', dim: '\x1b[2m', off: '\x1b[0m' };
if (warns.length) {
  console.log(`\n${c.yellow}警告 ${warns.length} 条${c.off}`);
  warns.forEach((w) => console.log(`  ${c.yellow}·${c.off} ${w}`));
}
if (errors.length) {
  console.log(`\n${c.red}错误 ${errors.length} 条${c.off}`);
  errors.forEach((e) => console.log(`  ${c.red}×${c.off} ${e}`));
  console.log();
  process.exit(1);
}
console.log(`\n${c.green}✓ 数据校验通过${c.off} ${c.dim}（警告 ${warns.length} 条，不影响运行）${c.off}\n`);
