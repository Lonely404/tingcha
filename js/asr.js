/**
 * asr.js — 浏览器原生语音识别封装
 *
 * 用 Web Speech API（Chrome / Edge 可用，Safari 14+ 部分可用）。
 * 粤语识别用 zh-HK；识别不准是我们要的，不做任何纠错后处理。
 *
 * 关键：这个模块一定会「失败」。权限被拒、不支持、静默超时、返回空字符串，
 * 四种情况都必须回到打字模式，不能让玩家卡住。
 */

const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export function isSupported() {
  return !!SR;
}

export function createRecognizer({
  lang = 'zh-HK',
  onInterim,
  onFinal,
  onError,
  timeoutMs = 8000,
} = {}) {
  if (!SR) {
    onError?.({ code: 'unsupported', message: '当前浏览器不支持语音识别' });
    return null;
  }

  const rec = new SR();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  let finalText = '';
  let timer = null;
  let settled = false;

  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { rec.stop(); } catch {}
    if (result.text) onFinal?.(result);
    else onError?.({ code: 'empty', message: '没有听到内容' });
  };

  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (interim) onInterim?.(interim);
    if (finalText) finish({ text: finalText.trim(), confidence: e.results[e.results.length - 1][0].confidence });
  };

  rec.onerror = (e) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const map = {
      'not-allowed': '麦克风权限被拒绝',
      'service-not-allowed': '麦克风权限被拒绝',
      'no-speech': '没有听到声音',
      'audio-capture': '找不到麦克风',
      'network': '识别服务连不上',
      'aborted': '已取消',
    };
    onError?.({ code: e.error, message: map[e.error] || '语音识别出错' });
  };

  rec.onend = () => {
    if (!settled) finish({ text: finalText.trim() });
  };

  return {
    start() {
      settled = false;
      finalText = '';
      try {
        rec.start();
      } catch (err) {
        onError?.({ code: 'start-failed', message: '启动识别失败' });
        return;
      }
      timer = setTimeout(() => finish({ text: finalText.trim() }), timeoutMs);
    },
    stop() {
      try { rec.stop(); } catch {}
    },
    abort() {
      settled = true;
      clearTimeout(timer);
      try { rec.abort(); } catch {}
    },
  };
}
