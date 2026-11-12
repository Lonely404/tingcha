# 数据与接口契约

> 这一份是三个人的共同语言。**已冻结，改动需先在群里说一声**——因为你改一个字段名，另外三个人的活会同时断。

责任人：`scenes.json` / `lines.json` 归电信A，`phonetic-map.json` 归电信B，字段结构归主程。改完统一跑 `node tools/lint-data.mjs`。

---

## 一、`data/scenes.json` — 剧情图

```
{
  "scenes": [
    {
      "id": "cha-chaan-teng",        // 全局唯一，英文短横线
      "title": "茶餐厅",
      "subtitle": "下午三点，你第一次自己点单",
      "entry": "enter",              // 入口节点 id
      "nodes": { "<节点id>": { ...节点 } }
    }
  ]
}
```

### 节点三种类型

**1. `narrate` — 旁白 / 对方反应 / 事故后果**

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | ✓ | `"narrate"` |
| `npc` | | 说话人名字。写 `"旁白"` 会渲染成无气泡的侧栏旁白 |
| `text` | ✓ | 正文，`\n` 换行有效 |
| `next` | ✓ | 下一个节点 id |
| `explain` | | 走这里时让刘看山讲解。值必须是 `lines.json` 里 `mishear` 的**某个 key**（即 lineId，不是误听 id） |

**2. `speak` — 等玩家开口**

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | ✓ | `"speak"` |
| `npc` / `npcLine` | ✓ | 谁在问你、他说什么 |
| `sayTo` | ✓ | 玩家要说的那句话（报告里拿它和识别结果对照） |
| `prompt` | ✓ | 输入框下方的提示，形如「你要说：唔该，一杯冻柠茶」 |
| `expect` | ✓ | 音近词表的 key |
| `onCorrect` | ✓ | 说对了去哪 |
| `onMishear` | | `{ "<误听id>": "<节点id>" }`，key 必须和词表里的 `mishears[].id` 完全一致 |
| `onFallback` | ✓ | 识别不出 / 词表没命中时去哪。**不能省**，省了就是断线 |

> `prompt` 里只写"你要说哪句话"，**不许写怎么读**。不许出现"注意声调""n 发成 l"之类。这是产品红线，不是风格建议。

**3. `ending` — 场景收尾**

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | ✓ | `"ending"` |
| `text` | ✓ | 收尾文案 |

---

## 二、`data/phonetic-map.json` — 音近词表

```json
{
  "<key>": {
    "canonical": "冻柠茶",
    "gloss": "冰柠檬茶",
    "correct": ["冻柠茶", "凍檸茶", "冻拧茶"],
    "mishears": [
      {
        "id": "ling-cha",
        "label": "冻零茶",
        "heard": ["冻零茶", "凍零茶", "冻玲茶"],
        "lineId": "ning-to-ling",
        "note": "「柠」ning、「零」ling，懒音把 n 并入 l。",
        "verified": false
      }
    ]
  }
}
```

- `correct` / `heard` 里放的是 **ASR 可能吐出来的原文**，繁体也要收，因为粤语识别经常返回繁体
- `label` 是给人看的"对方听到的那个词"，报告页和分享文案用它
- `verified: false` 表示还没实测过，`lint-data.mjs` 会一直警告。**电信B实测通过后改成 true**
- 匹配顺序：精确正确 → 精确误听 → 最长别名包含 → 全部落空走 `onFallback`
- 刻意不做模糊相似度匹配：它会让同一句话在不同设备上稳定落到不同分支，剧本就白写了；"落不到"反而可以有设计好的兜底

---

## 三、`data/lines.json` — 刘看山台词库

| 字段 | 说明 |
|---|---|
| `idle[]` | 玩家开口**之前**说的话。必须沉默或"试下啦"，**禁止任何发音提示** |
| `correct[]` | 说对之后一句轻描淡写 |
| `mishear{lineId: string[]}` | 每个音近词对一组，建议 2-3 句。第 1 句是歪头瞬间的短吐槽，第 2、3 句是后果演出后的讲解 |

`lineId` 是全库唯一的字符串，词表的 `mishears[].lineId` 和剧情节点的 `explain` 都指向它。加一句台词前先确认这三个地方对得上。

`_meta.forbiddenInIdle` 是禁用词表，`lookshan.js` 和 `lint-data.mjs` 都读它。

---

## 四、`data/fallback.json` — 降级内容池

| 字段 | 说明 |
|---|---|
| `explainTemplate` | 直答挂了时，用本局真实记录拼解析文案。占位符 `{n}` `{expected}` `{heard}` `{note}` |
| `stories[]` | 搜索挂了时展示的预存事故。`url` 为 `null` 时前端不渲染"查看原帖" |
| `emptySearch.notice` | 搜索返回空时的那句话 |

**不要编造知乎链接。** `url` 拿不到就留 null，空着比假的好。

---

## 五、后端接口契约（电信B 按这个写，前端已经接好了）

前端已经按下面的形状调用，**接口实现之前整站可以正常跑完整局**，只是走降级。所以不用等，照这个实现即可。

### `GET /api/search?q=<宽语义查询>`

```json
{
  "items": [
    { "title": "在茶餐厅点冻柠茶被听成冻零茶", "excerpt": "……", "author": "某人", "url": "https://www.zhihu.com/question/..." }
  ],
  "notice": null
}
```

- 查询串由前端固定传入宽语义查询（实测窄词对召回差），后端不要再收窄
- 缓存 24 小时，key = 查询串
- 额度耗尽 / 上游失败 → 返回 `{"items":[],"notice":"搜索额度已用尽，先看看这几条预存记录"}`，**必须带 notice**
- 超时策略：搜索 3.5s、直答 12s（生成慢，给足时间）、额度 2.5s。超时或非 2xx → 走本地内容
- 熔断：返回 404/405 或网络层失败后，前端判定接口不可用并静默 5 分钟不再重试。**所以后端上线后如果返回 404，用户要等 5 分钟才会重新请求** —— 路由路径严格按上面的写

### `POST /api/explain`

请求：

```json
{ "mistakes": [{ "expected": "唔该，一杯冻柠茶", "heard": "冻零茶" }], "turns": 2 }
```

响应：

```json
{ "text": "这一局你一共说岔了 1 次。……" }
```

- 每局只调一次，全局额度 100 次/天，是整条链路的瓶颈
- 失败返回非 2xx 即可，前端会自动用本地模板生成，文案质量够用
- **绝不能在游玩过程中调**。过程台词全部离线

### `GET /api/quota`

```json
{ "search": { "used": 12, "limit": 5000 }, "explain": { "used": 3, "limit": 100 } }
```

给"剩余低于阈值自动切全缓存模式"用。**目前前端只导出了 `checkQuota()`，还没有任何地方调用它**——额度监控这一环是空的，需要主程在第三周接上（建议：进首页时静默查一次，剩余低于 20% 就把 `explainSession` 改为直接返回本地文案）。

### 跨域部署（重要）

方案里的部署是 **前端 GitHub Pages + 后端 Vercel**，两者不同域。前端 `api.js` 的 `BASE` 读 `window.__API_BASE__`，所以后端上线后要在 `index.html` 里加一行：

```html
<script>window.__API_BASE__ = 'https://<你的-vercel-域名>';</script>
```

并在后端所有响应里加 `access-control-allow-origin: <前端域名>`，以及对 `OPTIONS` 预检直接返回 204。前端已确保 GET 不带 `content-type`（否则跨域会强制预检）。

### 通用要求

- Access Secret 只读 `process.env`，任何响应体、错误信息、日志里都不能出现
- 所有响应 `cache-control: no-store`（额度类）/ `max-age=86400`（搜索结果）
- 出错返回带 `notice` 的 JSON，不要返回 HTML 错误页——前端 `res.json()` 会崩

---

## 六、改动的正确姿势

1. 只改自己负责的那个文件
2. 跑 `node tools/lint-data.mjs`，零 error 再提交
3. 动了字段结构 → 先在群里说，主程同步改引擎
4. 提交信息写清楚改了哪几条剧情，方便回溯
