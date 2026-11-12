/**
 * api.js — 后端调用层（前端这一侧）
 *
 * 五条铁律：
 *   1. 任何调用失败都不能把界面卡住。拿不到就用本地内容，并且把「这是降级内容」带回 UI。
 *   2. 超时按接口分档：搜索 3.5s、直答 12s（生成本来就慢）、额度 2.5s。
 *   3. 熔断按接口隔离：直答慢不该连坐搜索。静态部署下 /api/* 必然 404，也不能每局都空等。
 *   4. 前端与后端不同域时（GitHub Pages + Vercel），地址通过 window.__API_BASE__ 注入，
 *      不要写死同域——写死等于部署当天整条 AI 链路静默降级。
 *   5. GET 不带 content-type：application/json 不在 CORS 安全头白名单里，
 *      跨域 GET 会被迫走 OPTIONS 预检，后端没处理就直接失败。
 *
 * 返回结构统一：{ ok, source:'live'|'fallback', notice, data, error? }
 */

const BASE =
  (typeof window !== 'undefined' && window.__API_BASE__) ||
  '';

const TIMEOUT = { search: 3500, explain: 12000, quota: 2500 };
const DOWN_MS = 5 * 60 * 1000;

/** 每个接口单独记熔断截止时间，互不影响 */
const downUntil = Object.create(null);

const scopeOf = (path) => (/^\/api\/([a-z]+)/.exec(path) || [])[1] || 'api';

export function isApiDown(scope = 'search') {
  return Date.now() < (downUntil[scope] || 0);
}

function markDown(scope, reason) {
  downUntil[scope] = Date.now() + DOWN_MS;
  console.info(`[api] ${scope} 标记不可用 ${DOWN_MS / 1000}s（${reason}），期间直接走本地内容`);
}

async function request(path, { timeout = 4000, ...opts } = {}) {
  const scope = scopeOf(path);
  if (isApiDown(scope)) {
    const e = new Error(`${scope} circuit-open`);
    e.code = 'circuit-open';
    throw e;
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const headers = { ...(opts.headers || {}) };
  if (opts.body != null) headers['content-type'] = 'application/json';

  try {
    const res = await fetch(BASE + path, { ...opts, signal: ctrl.signal, headers });
    // 静态部署最常见的就是这个：根本没有这个路由
    if (res.status === 404 || res.status === 405) {
      markDown(scope, 'HTTP ' + res.status);
      throw new Error('HTTP ' + res.status);
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } catch (err) {
    // 只有「连不上 / 超时」才熔断；业务 5xx 让下一次重试，别一次抖动锁 5 分钟
    if (err.name === 'AbortError') markDown(scope, 'timeout');
    else if (err.name === 'TypeError') markDown(scope, 'network');
    throw err;
  } finally {
    clearTimeout(t);
  }
}

/** 搜索真实事故。失败 -> fallback.json 里的 stories */
export async function searchStories(query, fallbackData) {
  try {
    const data = await request(`/api/search?q=${encodeURIComponent(query)}`, { timeout: TIMEOUT.search });
    if (!data?.items?.length) {
      return {
        ok: true,
        source: 'live',
        notice: fallbackData?.emptySearch?.notice || '没有搜到同类事故。',
        data: fallbackData?.stories || [],
      };
    }
    return { ok: true, source: 'live', notice: data.notice || null, data: data.items };
  } catch (err) {
    return {
      ok: false,
      source: 'fallback',
      notice: isApiDown('search')
        ? '搜索接口当前不可用（已熔断，5 分钟内不再重试），以下是预存记录。'
        : '搜索接口不可用，以下是预存记录（不含原帖链接）。',
      data: fallbackData?.stories || [],
      error: String(err?.message || err),
    };
  }
}

/** 整局解析。每局只调一次。失败 -> 本地模板生成 */
export async function explainSession(payload, localText) {
  try {
    const data = await request('/api/explain', {
      method: 'POST',
      body: JSON.stringify(payload),
      timeout: TIMEOUT.explain,
    });
    if (!data?.text) throw new Error('empty');
    return { ok: true, source: 'live', notice: null, data: data.text };
  } catch {
    return {
      ok: false,
      source: 'fallback',
      notice: '直答接口不可用，以下解析由本地模板生成，内容仍来自本局真实记录。',
      data: localText,
    };
  }
}

/** 额度查询，给「低额度自动切缓存模式」用 */
export async function checkQuota() {
  try {
    const data = await request('/api/quota', { timeout: TIMEOUT.quota });
    return { ok: true, data };
  } catch {
    return { ok: false, data: null };
  }
}
