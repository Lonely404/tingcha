/**
 * matcher.js — 音近词匹配
 *
 * 设计取向：宁可走兜底，也不让剧情乱飞。
 * 只做「精确 + 包含」两级匹配，不做模糊相似度。
 * 理由：模糊匹配会让同一句话在不同设备上稳定地落到不同分支，
 * 剧本就白写了；而「落不到」是可以设计兜底剧情的。
 */

const PUNCT = /[\s\u3000。，、！？；：「」『』（）()[\]【】""''…—\-~·.,!?;:0-9]/g;

/** 归一化：去标点空白、全角转半角、小写。繁简不做转换，靠词表里同时收繁体别名解决。 */
export function norm(s) {
  return String(s ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    .replace(PUNCT, '');
}

/**
 * @param {object} entry phonetic-map 里的一条
 * @param {string} heardRaw ASR 原始输出
 * @returns {{outcome:'correct'|'mishear'|'empty'|'unknown', mishear?:object, matched?:string}}
 */
export function matchHeard(entry, heardRaw) {
  const heard = norm(heardRaw);
  if (!heard) return { outcome: 'empty' };
  if (!entry) return { outcome: 'unknown' };

  const canon = norm(entry.canonical);
  const correctAliases = (entry.correct || []).map(norm).filter(Boolean);
  const mishears = entry.mishears || [];

  // 一级：完全匹配
  if (heard === canon || correctAliases.includes(heard)) {
    return { outcome: 'correct', matched: heardRaw };
  }
  for (const m of mishears) {
    const aliases = [m.label, ...(m.heard || [])].map(norm).filter(Boolean);
    if (aliases.includes(heard)) return { outcome: 'mishear', mishear: m, matched: heardRaw };
  }

  // 二级：包含匹配，最长别名优先（避免短别名误抢）
  const pool = [
    ...[canon, ...correctAliases].map((a) => ({ a, type: 'correct', ref: null })),
    ...mishears.flatMap((m) =>
      [m.label, ...(m.heard || [])].map((a) => ({ a: norm(a), type: 'mishear', ref: m }))
    ),
  ]
    .filter((x) => x.a && x.a.length >= 2)
    .sort((x, y) => y.a.length - x.a.length);

  for (const item of pool) {
    if (heard.includes(item.a)) {
      return item.type === 'correct'
        ? { outcome: 'correct', matched: heardRaw }
        : { outcome: 'mishear', mishear: item.ref, matched: heardRaw };
    }
  }

  // 全部落空 —— 交给剧本的 onFallback
  return { outcome: 'unknown', matched: heardRaw };
}
