/**
 * lookshan.js — 刘看山状态机
 *
 * 四个状态：idle（待机）/ headtilt（歪头）/ explain（讲解）/ report（递报告）
 *
 * 硬约束（写进代码，不靠自觉）：
 *   进入 speak 节点时必须处于 idle，idle 状态下说的话不许包含任何发音提示。
 *   一旦玩家在被提醒后开口，他就会小心发音，核心机制当场失效。
 *   所以这里不是「建议不要提示」，是 say() 会直接拦掉违规台词。
 */

const FORBIDDEN = ['发音', '声调', '声母', '韵母', '注意', '读成', '读作', '应该读', '正确读音', '懒音', '卷舌', '口型', '重音'];

export const STATES = {
  IDLE: 'idle',
  HEADTILT: 'headtilt',
  EXPLAIN: 'explain',
  REPORT: 'report',
};

/** 合法迁移表。玩家开口前只允许停在 IDLE —— 这是设计约束的可执行版本。 */
const TRANSITIONS = {
  [STATES.IDLE]: [STATES.IDLE, STATES.HEADTILT, STATES.REPORT],
  [STATES.HEADTILT]: [STATES.EXPLAIN, STATES.IDLE, STATES.REPORT],
  [STATES.EXPLAIN]: [STATES.IDLE, STATES.HEADTILT, STATES.REPORT],
  [STATES.REPORT]: [STATES.IDLE],
};

export class Kanzan {
  constructor({ artEl, bubbleEl, lines, onStateChange } = {}) {
    this.artEl = artEl;
    this.bubbleEl = bubbleEl;
    this.lines = lines || {};
    this.state = STATES.IDLE;
    this.onStateChange = onStateChange;
    this._pick = {};
    this._render();
  }

  _render() {
    if (this.artEl) {
      this.artEl.dataset.state = this.state;
      this.artEl.classList.remove('bounce');
      if (this.state === STATES.HEADTILT) {
        void this.artEl.offsetWidth; // 强制重排，让动画能重复触发
        this.artEl.classList.add('bounce');
      }
    }
    this.onStateChange?.(this.state);
  }

  canGo(next) {
    return (TRANSITIONS[this.state] || []).includes(next);
  }

  setState(next) {
    if (next === this.state) return true;
    if (!this.canGo(next)) {
      console.warn(`[kanzan] 非法迁移 ${this.state} -> ${next}，已忽略`);
      return false;
    }
    this.state = next;
    this._render();
    return true;
  }

  /** 顺序轮播台词，避免每次都同一句 */
  pick(bucket, key) {
    const arr = key ? this.lines?.[bucket]?.[key] : this.lines?.[bucket];
    if (!Array.isArray(arr) || !arr.length) return null;
    const i = this._pick[bucket + ':' + (key || '')] ?? 0;
    this._pick[bucket + ':' + (key || '')] = i + 1;
    return arr[i % arr.length];
  }

  /**
   * 说话。state 决定要不要走约束检查。
   * @returns {Promise<void>} 打字机效果结束
   */
  async say(text, { state = this.state, hold = 0 } = {}) {
    if (!text) return;
    if (state === STATES.IDLE) {
      const hit = FORBIDDEN.find((w) => text.includes(w));
      if (hit) {
        console.error(`[kanzan] 待机台词出现发音提示「${hit}」，已拦截：${text}`);
        text = '……（耳朵动了一下）';
      }
    }
    if (this.bubbleEl) {
      this.bubbleEl.dataset.empty = 'false';
      this.bubbleEl.textContent = text;
      this.bubbleEl.classList.add('pop');
      setTimeout(() => this.bubbleEl.classList.remove('pop'), 260);
    }
    if (hold) await sleep(hold);
  }

  clear() {
    if (this.bubbleEl) {
      this.bubbleEl.textContent = '';
      this.bubbleEl.dataset.empty = 'true';
    }
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
