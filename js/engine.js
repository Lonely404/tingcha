/**
 * engine.js — 分支引擎（纯逻辑，无 DOM，可 node 里单测）
 *
 * 一次「玩家开口」= 一次 turn：
 *   文本 -> 归一化 -> 查音近词表 -> correct / mishear / unknown
 *        -> 按节点的 onCorrect / onMishear[id] / onFallback 跳转
 *
 * 引擎只负责「去哪」，不负责「怎么演」。演出归 main.js + lookshan.js。
 */

import { matchHeard, norm } from './matcher.js';

export class Engine {
  constructor({ scenes, phonetic, lines }) {
    this.scenes = scenes.scenes || scenes;
    this.phonetic = phonetic;
    this.lines = lines || {};

    this.scene = null;
    this.nodeId = null;
    this.turns = [];        // 每次开口都记一条，结局报告从这里生成
    this.sceneLog = [];     // 走过的场景
    this.mistakes = 0;
  }

  get sceneList() {
    return this.scenes.map((s) => ({ id: s.id, title: s.title, subtitle: s.subtitle }));
  }

  /**
   * 进入一个场景。
   * keepLog=true 时保留已积累的开口记录（跨场景连续游玩要用，否则报告只剩最后一关）。
   */
  start(sceneId, { keepLog = false } = {}) {
    this.scene = this.scenes.find((s) => s.id === sceneId) || this.scenes[0];
    this.nodeId = this.scene.entry;
    if (!keepLog) {
      this.turns = [];
      this.mistakes = 0;
      this.sceneLog = [];
    }
    this.sceneLog.push(this.scene.id);
    return this.node();
  }

  node() {
    return this.scene.nodes[this.nodeId] || null;
  }

  goTo(nodeId) {
    if (!nodeId || !this.scene.nodes[nodeId]) {
      throw new Error(`[engine] 节点不存在: ${nodeId}`);
    }
    this.nodeId = nodeId;
    return this.node();
  }

  isFinished() {
    const n = this.node();
    return !n || n.type === 'ending';
  }

  /**
   * 玩家开口。返回一次完整的判定结果。
   * @param {string} rawText ASR 结果或打字输入
   * @param {{via?:'asr'|'typing', heardRaw?:string}} opts
   */
  speak(rawText, opts = {}) {
    const n = this.node();
    if (!n || n.type !== 'speak') {
      throw new Error('[engine] 当前节点不接受开口');
    }

    const entry = this.phonetic[n.expect];
    const verdict = matchHeard(entry, rawText);

    let nextId;
    let mishear = null;

    if (verdict.outcome === 'correct') {
      nextId = n.onCorrect;
    } else if (verdict.outcome === 'mishear') {
      mishear = verdict.mishear;
      nextId = n.onMishear?.[mishear.id] ?? n.onFallback;
    } else {
      nextId = n.onFallback;
    }

    const turn = {
      sceneId: this.scene.id,
      sceneTitle: this.scene.title,
      nodeId: this.nodeId,
      expected: n.sayTo,
      heard: opts.heardRaw ?? rawText,
      sayText: rawText,
      via: opts.via ?? 'typing',
      outcome: verdict.outcome,
      mishearId: mishear?.id ?? null,
      label: mishear?.label ?? null,
      note: mishear?.note ?? null,
      lineId: mishear?.lineId ?? null,
      nextNodeId: nextId,
    };

    if (verdict.outcome === 'mishear') this.mistakes += 1;
    this.turns.push(turn);
    this.goTo(nextId);

    return turn;
  }

  /** 当前局的结构化报告，给结局页用 */
  report() {
    const mistakes = this.turns.filter((t) => t.outcome === 'mishear');
    return {
      mistakes: mistakes.map((t) => ({
        sceneTitle: t.sceneTitle,
        expected: t.expected,
        heard: t.heard,
        label: t.label,
        note: t.note,
        lineId: t.lineId,
      })),
      unknown: this.turns.filter((t) => t.outcome === 'unknown').length,
      totalTurns: this.turns.length,
      sceneTitles: [...new Set(this.turns.map((t) => t.sceneTitle))],
    };
  }
}

/** 离线解析生成器：直答不可用时的保底文案，内容仍来自本局真实记录 */
export function explainLocal(report, tpl) {
  const items = report.mistakes;
  if (!items.length) {
    return '这一局你一句都没被听岔。要么你说得准，要么你把每句话都说成了最简单的那句。';
  }
  const parts = [];
  parts.push((tpl?.opening || '这一局你一共说岔了 {n} 次。').replace('{n}', String(items.length)));
  for (const it of items) {
    parts.push(
      (tpl?.perItem || '你想说「{expected}」，对方听到的是「{heard}」。{note}')
        .replace('{expected}', it.expected)
        .replace('{heard}', it.label || it.heard)
        .replace('{note}', it.note || '')
    );
  }
  parts.push(tpl?.closing || '这些不是「发音不标准」，是两个字本来就贴得太近。');
  return parts.join('\n\n');
}

/** 分享文案 */
export function shareText(report) {
  const total = report.totalTurns ?? report.mistakes.length;
  if (!report.mistakes.length) {
    return `我在《听岔》里说了 ${total} 句，一个词都没被听岔。这不正常。`;
  }
  const m = report.mistakes[0];
  return `我在《听岔》里想说「${m.expected}」，对方听到的是「${m.label || m.heard}」。${total} 句里我岔了 ${report.mistakes.length} 次。`;
}

export { norm };
