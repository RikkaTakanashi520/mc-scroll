# MC Scroll

像刷短视频一样刷 Minecraft 的全部资源：模组、整合包、数据包、资源包、光影、服务端插件、服务器。

- **桌面端（≥900px）**：三栏布局
  - 左侧：项目类型 / 游戏版本 / 分类 / 加载器（版本按大版本分组，可多选）
  - 中间：内容流
  - 右侧：项目详情（截图墙、数据、全部版本、正文）
- **手机端（<900px）**：单栏全屏刷流，上下滑换内容、左右滑看截图、点星标收藏
- **中英双语**：左侧栏底部切换，立即生效；首次访问按浏览器语言自动选择
  - 界面文案手工翻译（见 `public/js/i18n.js`）
  - 项目简介机翻 + 术语纠正入库（`scripts/translate-summaries.mjs`）

> 顶部频道条已移除 —— 桌面用左侧栏、移动端用筛选面板，两处都能选类型，顶部再放一排属于重复。

全站 **169,451 个项目、292,803 张截图、72,199 个可刷内容**，纯英文，分类体系与 Modrinth 完全一致。

## 数据规模

| 频道 | 项目数 | 有截图（可刷） |
|---|---:|---:|
| Mod | 108,421 | 45,587 |
| Resource Pack | 37,703 | 18,371 |
| Modpack | 19,281 | 7,326 |
| Plugin | 20,025 | 4,006 |
| Datapack | 15,862 | 6,505 |
| Shader | 1,121 | 881 |
| Server | 2,543 | 34 |
| **合计** | **169,451** | **72,199** |

分类体系：**145 个分类 / 29 个加载器 / 925 个游戏版本**，全部表驱动，与 Modrinth 官方 taxonomy 一致。

## 快速开始

```bash
node server/index.mjs
# 打开 http://127.0.0.1:4173/
```

### 数据库不随仓库提供

`data/mc.db` 有 **654MB**，远超 GitHub 单文件 100MB 上限，所以 `.gitignore` 里排除了它。
数据是抓出来的，按下面的流程在本机重建即可（全流程约 1.5 小时）：

```bash
node scripts/crawl.mjs --taxonomy           # 同步分类体系（几秒）
node scripts/crawl.mjs --all --resume       # 全量抓取（约 40 分钟）
node scripts/enrich.mjs --min-downloads 500 # 补截图详情
node scripts/build-feed-index.mjs           # 重建随机采样索引（必跑）
node scripts/warm-images.mjs --limit 5000   # 预热图片缓存（强烈建议）
```

> 注意：抓到新数据或补完详情后，**必须重跑 `build-feed-index.mjs`**，
> 否则随机流用的还是旧的项目编号，新内容不会出现。

> 图片代理需要 Python + Pillow。若用非标准路径，设置环境变量
> `MC_SCROLL_PYTHON` 指向 python 可执行文件；未设置时会退回原图（能显示但慢）。

## 架构

```
public/                前端（纯静态）
  index.html
  css/app.css
  js/app.js            视图逻辑 + 无限流
server/
  schema.mjs           数据库 schema（表驱动分类）
  db.mjs               数据库连接与初始化
  index.mjs            HTTP API + 静态服务 + 图片代理路由
  imgproxy.mjs         图片下载/缩放/缓存
scripts/
  crawl.mjs            全量抓取（断点续传）
  enrich.mjs           补截图详情（带并发占位）
  warm-images.mjs      预热缩略图缓存
  build-feed-index.mjs 构建随机采样索引（数据变动后需重跑）
  translate-summaries.mjs 项目简介翻译（含术语纠正）
  test-v2.mjs          真实浏览器回归测试
data/
  mc.db                SQLite 数据库（654MB，不进仓库，按上面流程重建）
  imgcache/            缩略图磁盘缓存（自动生成，不进仓库）
```

### 数据库设计（为「后期能加东西」）

三层分离，加新来源不改表结构：

1. **`projects`** — 与来源无关的通用字段
2. **`project_sources`** — 一个项目可同时来自 Modrinth 和 CurseForge，
   接入 CurseForge 只需插一行，不用改 `projects`
3. **`taxonomy_*`** — 分类/加载器/版本全部表驱动，不写死枚举

关键设计：
- **`channels` 多归属字段**（逗号分隔）：一半项目既是 mod 又是 datapack，单值 `project_type` 表达不了
- **`enriched` 状态位**：0=未补详情 / 2=处理中 / 1=完成，用来做并发占位
- **FTS5 全文索引**：17 万项目模糊搜索保持 40ms 级
- **`weight` 预计算**：抓取时算好，避免每次查询算 log()

## 关键实现决策（都是踩坑后改的）

### 1. 图片加载：本地代理 + 磁盘缓存 + 预热

实测三种图源（首屏 10 张并发）：

| 图源 | 单张耗时 | 大小 |
|---|---|---|
| cdn.modrinth.com 直连 | 25ms ~ 4100ms（波动极大） | 60KB |
| 正文插图原图直连 | 100ms ~ 1s | **1~2MB** |
| imgur / github 外链 | **8~10 秒超时** | — |

策略演进（三次都踩了坑）：

1. **一开始全用原图** → 31% 的项目首图 1~2MB，首屏等好几秒
2. **改成「CDN 有缩略图就直连」** → 仍有 2s/4s 的慢图，因为国内访问 CDN 不稳定
3. **全部走本地代理** → 首屏快了，但**画面糊了**：CDN 的 `_350.webp` 只有 350px，
   卡片区宽 920px，放大 2.6 倍，肉眼可见糊
4. **改成「代理取原图」求清晰** → 清晰了，但首屏崩了：

   | 方案 | 首屏出图 | 失败率 |
   |---|---:|---:|
   | 代理取原图（1~4MB） | **15 秒** | **31/45 = 69%** |
   | CDN 缩略图直连（60KB） | **423ms** | 0% |

   实测这台机器到 Modrinth CDN 的吞吐很差：216KB 要 3 秒、420KB 要 5~11 秒，
   **和文件大小几乎无关，是链路问题**。所以代理取原图这条路根本走不通。

**最终：两级加载**——先能看，再好看。

1. 后端同时返回两个地址：
   - `thumb` → CDN 直连缩略图（几十 KB，快）
   - `full`  → 本地代理缩放后的 1280px（慢，但清晰）
2. 前端首屏用 `thumb`，423ms 就能出图
3. 卡片**停留 700ms** 后，用 `new Image()` 在后台静默预载 `full`
4. **加载成功才替换；失败就保留缩略图，绝不出现空白**

```js
// 关键：后台预载，成功才换
const pre = new Image();
pre.onload  = () => { if (stillCurrent) target.src = full; };
pre.onerror = () => {};          // 失败保持缩略图
pre.src = full;
```

另外代理侧两处调整：
- 超时 8s → **15s**（原图常有 1~4MB）
- 超时/网络抖动**不再进 10 分钟黑名单**——否则一次抖动，这张图半小时都显示不出来

四个关键点：
- `/api/img` 后端代理，Pillow 缩放并落盘 WebP 缓存
- 上游并发闸门限 4，避免多个未缓存图互相抢带宽
- 失败过的 URL 进 10 分钟黑名单（**仅确定性失败**，临时超时不进）
- `scripts/warm-images.mjs` 预热热门首图

**效果：首屏 423ms 出图，停留后自动升级到 1280px 高清，失败率 0%。**

### 1.5 键盘操作与详情栏折叠

右上角「键盘」按钮展开快捷键面板，两列键位对照，跟随中英切换。

**键位表**（`KEYMAP` 数组是唯一事实来源，面板内容由它生成，改一处两边同步）：

| 分类 | 动作 | 键 |
|---|---|---|
| 浏览内容 | 下一个项目 | ↓ / j / 小键盘2 |
| | 上一个项目 | ↑ / k / 小键盘8 |
| 截图切换 | 下一张截图 | → / l / 小键盘6 |
| | 上一张截图 | ← / h / 小键盘4 |
| 右侧详情 | 向下滚 / 向上滚 | d / u（小键盘3 / 9） |
| | 折叠 / 展开 | \ |
| 操作 | 收藏 / 打开页 / 详情 | s / o / Enter |
| | 筛选 / 搜索 / 收藏夹 | f / / / b |
| | 开关面板 / 关闭浮层 | ? / Esc |

**三个踩过的坑**：

1. **小键盘方向键无效**
   NumLock 开启时，按小键盘方向键的 `e.key` 是 `'2' '8' '4' '6'` 而不是 `'ArrowDown'`。
   只判断 `e.key` 就完全没反应。必须同时判断 `e.code === 'Numpad2'` 这类物理位置。

2. **`e.target.matches()` 会抛异常**
   事件目标是 `window` 时没有 `.matches()`，直接调用抛 TypeError，
   **整个按键处理器静默失效**——所有快捷键一起失灵，且控制台不报明显错误。
   改成可选链：`e.target?.matches?.(...)`。

3. **图片切换要用索引倍乘**
   `.card-media` 有 `scroll-snap-stop: always`，直接 `scrollLeft += w` 会被吸附回原位（尤其连按）。
   改成 `scrollTo({ left: idx * w, behavior: 'instant' })` 一次跳到位。

**自定义键位**：点面板里任意一行进入录制态，按新键即绑定，存 localStorage。
四件事都做了：
- 绑定的同时从其他动作里摘掉同一个键（避免立刻冲突）
- 剩余冲突会在行内标「冲突」警告色
- 右侧「恢复默认」一键还原
- 关面板自动退出录制态，不会下次按任意键就被当成绑定

**图片切换的三个真 bug**（都是「按 → 切不过去 / 切过去白屏」的成因）：

1. **懒加载观察器观察错了对象**
   原来是逐张 `img` 观察，但 `.card-media` 是 `overflow-x: auto` 的横向容器，
   第 2 张及以后的图被**祖先裁切**在视口外。IntersectionObserver 会算上祖先 overflow 裁剪，
   所以这些图永远 `isIntersecting=false`，`src` 一直是空的。
   加 `rootMargin` 也没用——不是距离问题，是裁剪。
   **改成观察卡片本身**：卡片进视野就一次性给它的所有图赋 `src`。

2. **图片上不该用 `loading="lazy"`**
   原生 lazy 同样认为「横向屏外 = 不可见」，一直不发起请求。
   等滚过去才开始下载，而 CDN 单张要 1.3~3.4 秒，于是切一张黑一下。
   加载时机交给自己的观察器控制，`src` 一赋就立刻请求。

3. **当前卡片要立即载入全部图片**
   用户随时可能按 → 切图，不能等观察器慢慢回调。
   `renderWindow()` 里对 `state.cursor` 对应的卡片直接调 `loadCardImages()`。

**截图张数上限（第四个 bug）**：原来只能看前 6 张。

三处限制叠在一起，任何一处都会让用户「只能切前六张」：

| 位置 | 原值 | 现在 |
|---|---|---|
| 后端 `attachImages(cards, perProject)` | 6 | **24** |
| 前端 `buildCard` 里 `images.slice(0, 8)` | 8 | 移除 |
| 剩余部分 | 无接口 | `/api/images/:slug?from=&limit=` |

为什么是 24 而不是全部：实测数据里 **15.9% 的项目超过 6 张、最多 65 张**，
但 24 张已经覆盖 **P99**（99% 的项目不超过 23 张）。
一次全塞进 feed 会让 20 张卡的响应体翻几倍、首屏明显变慢，
所以剩下的等用户真翻到时再调接口补（`ensureAllImages`）。

**补图时踩的坑**：`appendImagesToMedia(media, card, from)` 的 `from` 参数
一不留神传了 `null`，会走「从头重建」分支，导致已经渲染的 24 张被再追加一遍。
实测 56 张的卡片变成 80 个 img（只有 56 个唯一 src），表现是「翻到后面出现重复图」。
现在补图时先数 DOM 里已渲染的数量，只从那个下标往后追加。

配合的测试断言：`img 数量 === 唯一 src 数量 === 角标数字`，三者必须一致。

配套的视觉兜底：加载中显示脉冲骨架、CDN 偶发 500（实测约 1%）显示斜纹占位，
不留纯黑让人以为「切换坏了」。

**详情栏折叠**：状态存 localStorage，刷新后保持。折叠后中间列从 820px 扩到 1166px，
图片按新宽度重新升级到高清。折叠用 `grid-template-columns` 过渡，不用 `display:none`
（后者会让图片重排时闪一下）。

### 2. 刷流为什么要按名次采样

踩了两个坑：

- **「weight + jitter 排序」无效**：Sodium 的 weight 来自 2.5 亿下载，和其他项目差好几个数量级，
  任何线性扰动都被淹没 —— 每次刷新首屏都是同样 6 个项目。
- **「按绝对 weight 加权采样」也几乎无效**：weight 是 log10 后的值（5~9），项目之间只差 0.1~0.3，
  pow 之后差距依然很小，头部项目几乎必中。

**正确做法：按名次给权重**（第 1 名权重 1，第 N 名 `1/N^0.85`）。
实测：连续 6 次刷新得到 6 种完全不同的顺序。

### 3. datapack / plugin 不是 project_type

直接 `project_type:datapack` 查询，**返回的却是 `project_type: mod` 的项目**（Modrinth 的真实结构）。

第一版抓了 1.5 万条 datapack「成功」但入库 0 条 —— 全被 slug 去重成 mod 了。

真实归属：
- **datapack 是 loader**，不是 category
- **plugin 同样是 loader**（paper/spigot/bukkit 等）

修正后用 `channels` 集合表达多归属，7 个频道全部有数据。

### 4. 并发补详情必须做占位

5 个 worker 同时查 `enriched=0` 会拿到同一批记录，同一批被反复下载，
进度跑到 **172%**（实测）。修正：先原子标记 `enriched=2`（处理中）再取，失败时还原。

### 5. 翻页游标要沿用同一个 seed

前端每次 `refill()` 若不带 cursor，后端会生成新 seed，从同一批高权重候选重新采样。
实测 4 批 120 条里重复 34 条（28%）。

修正：首次拿 seed，后续一直沿用同一 cursor 链；只有换筛选条件才重置。

### 6. 卡片绝对定位 + spacer

卡片 `position:absolute; top: idx*100dvh`，滚动高度由 `.feed-spacer` 撑起。

**绝不能**用 `scrollTop/高度` 当队列下标 —— 那只是渲染窗口内的相对序号，
一旦窗口前移游标就永远停在起点（第一版卡在第 4 张就是这个原因）。

### 11. 频道按钮与卡片属性重名

卡片用 `data-type`、频道用 `data-feed`。
早前两者都用 `data-channel`，`closest('[data-channel]')` 在卡片里会命中卡片本身，
点频道按钮等于点了卡片，切频道完全失效。

## API

```
GET /api/health                     服务和数据状态
GET /api/taxonomy                   分类体系（145 分类 / 29 加载器 / 925 版本）
GET /api/feed?types=&categories=&loaders=&versions=&q=&limit=&cursor=
GET /api/project/:slug              单项目详情（含全部截图与全部游戏版本）
GET /api/search?q=                  FTS5 全文搜索
GET /api/img?u=&w=                  图片代理（缩放 + 磁盘缓存）
GET/POST/DELETE /api/favorites      收藏（服务端存，为跨设备准备）
```

性能：刷流热态 **17ms**（P90 19ms），搜索 40~55ms，图片中位 10ms。

## 测试

```bash
node scripts/test-v2.mjs    # 19 项真实浏览器回归
```

覆盖：首屏渲染、下滑 20 张不重复、筛选面板、收藏落库、详情截图、搜索、无 JS 异常。

## 已知限制

- **Server 频道只有 34 个有截图**：Modrinth 上这类项目本来就少上传截图。
- **约 9.7 万项目无截图**：作者没上传，不是抓取遗漏（已用 `enriched` 标记避免重复抓）。
  「Only with screenshots」默认开启，所以刷流不会刷到它们。
- **外链图床图片被丢弃**：imgur/github 等实测 8~10 秒超时，
  与其让用户卡住，不如这张卡少一张截图（还有其他截图和图标兜底）。
- **收藏以本地为主**：`localStorage` 为主，同时异步写服务端；跨设备登录还没做。
- **CurseForge 未接入**：schema 已预留 `sources` 表，接入只需插一行 + 写个 adapter。
- **图片代理依赖 Python + Pillow**：未安装时会退回原图（功能可用但慢）。

## 数据来源

项目数据来自 [Modrinth](https://modrinth.com/) 官方 API，各项目版权归原作者所有。
本项目只做展示与跳转，不重新分发任何资源文件。

## 数据来源与合规

本项目**只读取 Modrinth 的公开 API**，不下载、不镜像、不分发任何模组文件。

- **所有内容版权归原作者**，界面里每个项目的「前往 Modrinth」都会跳到原页面
- 抓取的是元数据（标题、简介、分类、下载量）和截图的 CDN 链接，
  **图片通过 `/api/img` 代理只是为了缩放和缓存，不落盘原图**
- 若你是作者且不希望自己的项目出现在这里，提 issue 即可移除
- 本项目与 Modrinth / CurseForge 无隶属关系

## 环境变量

| 变量 | 用途 | 必需 |
|---|---|---|
| `MC_SCROLL_PYTHON` | 指向带 Pillow 的 Python 可执行文件 | 否（不设则退回原图，慢但能用） |
| `MC_TRANSLATE_KEY` | 翻译服务的 client_key，仅跑 `translate-summaries.mjs` 时需要 | 仅翻译时 |
| `PORT` / `HOST` | 监听端口与地址 | 否（默认 4173 / 127.0.0.1） |

## 贡献

```bash
node scripts/test-v2.mjs   # 改完代码先跑回归，39 项全过再提 PR
```

## 许可

代码以 MIT 许可发布（见 `LICENSE`）。抓取到的项目数据与截图版权归各自作者所有。
