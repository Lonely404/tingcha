<<<<<<< HEAD
# tingcha
tingcha project
=======
# 听岔 · 技术底座

> 知乎黑客松 S3 · 湾区共创季 ｜ 赛道：AI × 出海

把「你以为你说对了」变成一句能被听见的错话。这一份是软工部分的可运行底座：分支引擎、音近词匹配、刘看山状态机、语音接入、降级链路，以及给另外三位队友的**数据契约**。

---

## 跑起来

**Windows 双击 `start.bat`** 就行：自动起服务、自动开浏览器。

手动启动：

```bash
# 任意静态服务器都行，必须走 http
python -m http.server 8000
# 打开 http://localhost:8000
```

> ⚠️ **不要双击 `index.html`。** 浏览器不允许 `file://` 页面加载 ES 模块（origin 为 `null`），`js/main.js` 会一行都不执行，页面上的字是静态 HTML、场景卡片是空的。而且麦克风权限只在 `localhost` / `https` 下才给，双击打开注定用不了语音。
> 现在这种情况会弹出一块"启动失败"面板说明原因，不会再静默白屏。

自测（不开浏览器）：

```bash
node tools/lint-data.mjs      # 剧本数据校验：跳转、词表、台词约束
node tools/test-engine.mjs    # 引擎自测：66 项，含跨场景战绩、每条误听可达性
```

`lint-data.mjs` 会拦六类错：跳转到不存在的节点、旁白缺 `next`、`expect` 不在词表、
`onMishear` 的 key 对不上、`prompt` 里教发音、**同一个词同时写在 `correct` 和 `mishears`
里（该误听分支永远触发不了）**。

ASR 实测台（给电信B）：`http://localhost:8000/tools/asr-test.html`

### 打不开时的排查顺序

| 现象 | 原因 | 处理 |
|---|---|---|
| 只有文字、卡片区空白，弹出"启动失败"面板 | 用了 `file://` 打开 | 双击 `start.bat`，或起 http 服务器 |
| 面板写"模块已请求，但 5 秒内未完成启动" | 路径配错 / MIME 不对 / 脚本 404 | F12 看 Network，确认 `js/main.js` 是 200 且 Content-Type 为 `application/javascript` |
| 页面正常但报告页两段内容写着"预存记录 / 本地模板" | 后端 `/api/*` 还没实现 | 正常降级，属预期 |
| 麦克风按钮点了没反应 | 非 localhost/https，或浏览器不支持 | 用 Chrome / Edge，走 localhost；或直接打字 |

---

## 目录

```
index.html              页面骨架（开始页 / 对话舞台 / 结局报告）
css/style.css           全部样式，无框架
js/main.js              流程编排，唯一碰 DOM 的一层
js/engine.js            分支引擎（纯逻辑，可 node 单测）
js/matcher.js           音近词匹配（归一化 + 精确 + 最长包含）
js/lookshan.js          刘看山四状态机 + 台词约束
js/asr.js               浏览器原生 SpeechRecognition 封装 + 四种失败兜底
js/api.js               后端调用 + 分档超时 + 熔断 + 降级
data/scenes.json        剧情图        ← 电信A
data/phonetic-map.json  音近词表      ← 电信B
data/lines.json         刘看山台词库  ← 电信A
data/fallback.json      降级内容池    ← 主程
tools/lint-data.mjs     数据校验      ← 每次改完 JSON 都跑
tools/test-engine.mjs   引擎自测
tools/asr-test.html     ASR 实测台    ← 电信B第一周就用这个
docs/data-contract.md   数据结构与接口契约（队友只看这一份）
```

---

## 已经能跑通的

- 三个场景完整剧情图（茶餐厅 / 便利店 / 问路），每场景 2 个开口节点
- 三种判定：说对 → 正常剧情；说岔 → 事故剧情 + 刘看山讲解；识别不出 → 兜底剧情（不断线）
- 刘看山四状态（待机 / 歪头 / 讲解 / 递报告）+ CSS 过渡，素材到位后换 `<img>` 即可
- 语音识别接入，麦克风被拒 / 浏览器不支持 / 超时 / 空结果 → 自动回打字模式
- 结局报告：词对对照表、离线解析、事故溯源、一键复制分享文案
- 接口全部带降级，前端**不依赖后端也能完整跑完一局**（现在就是这个状态）
- 跨场景连续游玩，战绩累计

## 还没做的（按周次排）

- 后端三个函数（`/api/search`、`/api/explain`、`/api/quota`）—— 契约已冻结，见 `docs/data-contract.md`
- OAuth 登录与分享回知乎
- 热榜「今日词」彩蛋
- 刘看山官方素材替换（现在是内联 SVG 占位）
- 真实帖子链接（`fallback.json` 里 url 全为 null，等电信A补）

---

## 软工这条线的三条红线

1. **玩家开口前不给任何发音提示。** 这条不是靠自觉：`lookshan.js` 里 `say()` 会拦截含"发音/声调/读成/懒音"等词的待机台词，`lint-data.mjs` 会在提交前再查一遍。提前提醒 = 玩家小心发音 = 核心机制当场失效。
2. **任何一次接口调用失败，玩家都不能卡住。** `api.js` 分档超时（搜索 3.5s / 直答 12s），拿不到就用本地内容，并且把"这是降级内容"明确写在界面上——手册提交清单第 7 条是评分项，静默降级等于白丢分。报告页的两个请求改为并行、本地内容先渲染，接口回来再回填，不再串行空等。
3. **Access Secret 只在服务端。** 前端代码、日志、截图、演示视频里出现一次就完了。前端所有请求都走同域 `/api/*`。

---

## 部署

- 前端：GitHub Pages（推 `main` 即发，自带 HTTPS，麦克风权限必须 HTTPS）
- 后端：Vercel Functions，环境变量放 `ZHIHU_CLIENT_ID` / `ZHIHU_CLIENT_SECRET` / `ZHIHU_ACCESS_SECRET`
- **前后端不同域**，后端上线后在 `index.html` 里注入 `window.__API_BASE__ = 'https://xxx.vercel.app'`，否则前端会一直请求同域 `/api/*` 并因 404 熔断，整条 AI 链路静默降级。细节见 `docs/data-contract.md` 第五节。
- 因为前端用 ES module + `fetch`，不能用 `file://` 直接双击打开，本地务必起服务器

---

## 给队友的一句话

改 `data/` 下任何 JSON 之后跑一次 `node tools/lint-data.mjs`，它会把"跳转到不存在的节点""词表里没有这个音""台词里出现了发音提示"三类错误直接指出来，不用等联调才发现。
>>>>>>> 9a9f9c2 (听岔：软工底座（分支引擎 + 音近词匹配 + 刘看山状态机 + ASR + 降级链路）)
