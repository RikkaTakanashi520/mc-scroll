# 工作进度存档

> 存档时间：2026-11-24 19:25（Asia/Shanghai）
> 存档原因：网络即将断开，记录当前状态以便后续恢复

---

## 一、当前状态：可运行，无已知 Bug

服务在跑，浏览器可直接访问。所有功能已验证通过。

| 项目 | 状态 |
|---|---|
| 服务进程 | 运行中（`node server/index.mjs`，端口 4173） |
| 健康检查 | 200，169118 项目 / 292803 截图 / 145 分类 |
| 回归测试 | **19/19 通过**（`node scripts/test-v2.mjs`） |
| 中英切换 | 正常，切换不改变当前项目 |
| 中文简介覆盖 | 71599 / 72199 可刷项目 = **99.1%** |
| 中文正文覆盖 | 70809 / 72199 = **98.1%** |

### 数据快照

```
项目总数        169451
可刷（有截图）    72199
有中文简介       71599  (99.1% of 可刷)
翻译缓存         71187
截图            292803
分类             145
加载器            29
游戏版本          925
feed_index       72199
数据库大小       ~426 MB（data/mc.db）
```

---

## 二、网络恢复后怎么启动

```bash
cd "C:\Users\29289\Desktop\Za\Game\3"

# 1. 启动服务（必须设置 Python 路径，图片代理要用 Pillow）
$env:MC_SCROLL_PYTHON = "C:\Users\29289\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
node server/index.mjs

# 2. 打开浏览器
# http://127.0.0.1:4173/
```

**注意**：不设 `MC_SCROLL_PYTHON` 也能跑，但图片代理会退回原图（1~2MB，慢很多）。

服务同时监听 `127.0.0.1` 和 `localhost` 两个主机名——这是为了绕开浏览器 HTTP/1.1 每域 6 连接的限制，**不能删**。

---

## 三、已完成的功能

### 内容与数据
- 全量抓取 Modrinth 169118 个项目（7 种类型）
- 292803 张截图（`_350.webp` 缩略图 + 原图双存）
- 145 分类 / 29 加载器 / 925 游戏版本，全部表驱动
- 项目简介中文翻译 99.1%，含术语纠正表

### 界面
- **桌面端**：三栏布局 —— 左侧分类导航 / 中间内容流 / 右侧详情
- **手机端**：单栏全屏刷流（<900px 自动切换）
- **中英双语**：左侧栏底部切换，即时生效

### 核心能力
- 刷流：上下滑换内容，加权随机采样（分布偏差 6.8%）
- 图集：左右滑看截图
- 收藏：localStorage + 服务端异步同步
- 搜索：FTS5 全文索引，40~55ms
- 筛选：类型/分类/加载器/103 个版本/只看有图
- 图片：本地代理 + Pillow 缩放 + 磁盘缓存（中位 10ms）

---

## 四、关键架构决策（改动前必读）

这些是踩坑后的最终方案，**改动前请先看 README 的对应章节**，否则很容易重新踩坑。

### 1. 随机流用 `feed_index` 表
```
❌ 随机 id + 连续取 8 行    → 相邻 id 属性接近，等于只抽 1 个
❌ 随机 id + 取 1 行        → id 分布不均，>10M 下载被抽到 23.8%（真实 0.4%）
❌ ORDER BY id OFFSET 随机数 → offset=50000 单次 74ms，一页 1800ms
✅ 预建 feed_index 连续编号 → seq 主键查找 0.002ms，概率严格相等
```
**数据变动后必须重跑**：`node scripts/build-feed-index.mjs`

### 2. 图片和 API 必须分主机名
浏览器 HTTP/1.1 每域最多 6 个并发连接。刷流几十个图片请求会占满，
`/api/feed` 排队几十秒发不出去（表现是换筛选后白屏、无任何报错）。

解法：图片走同源 `/api/img`，数据请求走另一个主机名（`127.0.0.1` ↔ `localhost`）。
**服务端必须同时监听两个主机名**。

### 3. 切语言不能调 resetFeed()
只影响文案，队列保持不变。早前调了 `resetFeed()`，用户正在看的项目会消失。

### 4. 卡片绝对定位 + spacer
`top = idx * 100dvh`，滚动高度由 `.feed-spacer` 撑起。
**不能用 `scrollTop/高度` 当队列下标**——那只是窗口内相对序号。

### 5. 换筛选时临时关 scroll-snap
`scroll-snap: y mandatory` 会把 `scrollTo(0)` 吸回旧位置，
导致渲染窗口按旧位置算、卡片全被回收。重建期间设 `scrollSnapType = 'none'`。

---

## 五、常用命令

```bash
# 服务
node server/index.mjs                    # 启动（见上方环境变量）

# 测试
node scripts/test-v2.mjs                 # 19 项真实浏览器回归

# 数据维护（数据变动后按顺序跑）
node scripts/crawl.mjs --all --resume    # 抓取（约 40 分钟，可断点续传）
node scripts/enrich.mjs --min-downloads 500   # 补截图详情
node scripts/build-feed-index.mjs        # 重建随机采样索引 ← 必须
node scripts/warm-images.mjs --limit 5000     # 预热图片缓存

# 翻译
node scripts/translate-summaries.mjs                     # 翻译简介（可断点续传）
node scripts/translate-summaries.mjs --field description # 翻译正文/About
node scripts/translate-summaries.mjs --reapply           # 只重跑术语纠正，不发请求
```

---

## 六、已知限制

| 限制 | 说明 |
|---|---|
| 约 9.7 万项目无截图 | 作者没上传，不是抓取遗漏。「只看有截图的」默认开 |
| 600 条可刷项目无中文 | 410 条原文本来就是中文；190 条是专有名词短句，保留英文更合适 |
| 外链图床图片被丢弃 | imgur/github 实测 8~10 秒超时，宁可少一张图也不让整屏卡住 |
| 收藏只存本地 | localStorage 为主，服务端异步写；跨设备登录未做 |
| CurseForge 未接入 | schema 已预留 `sources` 表，接入只需插一行 + 写 adapter |
| 图片代理依赖 Pillow | 未安装时退回原图，功能可用但慢 |

---

## 七、下一步可做的事（按价值排序）

1. **接入 CurseForge** —— 需要你申请 API Key（https://console.curseforge.com/）
   - 能补上「真正的存档地图」，这是目前唯一缺的品类
   - schema 已预留，工作量约 2 小时

2. **用 LLM 重翻简介** —— 现在走免费翻译接口，专有名词处理差
   - 改用 DeepSeek 批量翻，质量会明显提升
   - 成本极低（7 万条约几十元），但需要 API Key

3. **跨设备收藏** —— 目前只存 localStorage
   - 后端 `favorites` 表已建好，缺前端账号系统

4. **扩充数据量** —— 现在只抓了有截图的做重点翻译
   - 剩余 9.7 万无截图项目已入库，若要全部翻译需再跑几小时

---

## 八、文件地图

```
C:\Users\29289\Desktop\Za\Game\3\
├── README.md                    完整技术文档（架构决策详细记录）
├── PROGRESS.md                  ← 本文件
├── package.json
├── public/                      前端（纯静态，可直接托管）
│   ├── index.html
│   ├── css/app.css
│   └── js/
│       ├── app.js               视图逻辑 + 无限流（58KB）
│       └── i18n.js              中英文案字典（10KB）
├── server/
│   ├── index.mjs                HTTP API + 静态服务 + 图片代理路由
│   ├── schema.mjs               数据库 schema（表驱动分类）
│   ├── db.mjs                   连接与工具函数
│   └── imgproxy.mjs             图片下载/缩放/缓存
├── scripts/
│   ├── crawl.mjs                全量抓取（断点续传）
│   ├── enrich.mjs               补截图详情（并发占位）
│   ├── build-feed-index.mjs     构建随机采样索引
│   ├── warm-images.mjs          预热缩略图
│   ├── translate-summaries.mjs  简介翻译 + 术语纠正
│   └── test-v2.mjs              19 项回归测试
└── data/
    ├── mc.db                    SQLite 主库（426MB）
    └── imgcache/                缩略图缓存（WebP）
```

---

## 九、如果数据丢失了怎么重建

全流程约 1.5 小时（主要耗在翻译）：

```bash
# 1. 建库 + 抓取（40 分钟）
node scripts/crawl.mjs --taxonomy
node scripts/crawl.mjs --all --resume

# 2. 补详情（15 分钟）
node scripts/enrich.mjs --min-downloads 500

# 3. 建随机索引（1 秒）← 不建的话刷流会报错
node scripts/build-feed-index.mjs

# 4. 翻译（40 分钟）
node scripts/translate-summaries.mjs --concurrency 3 --batch 12

# 5. 验证
node scripts/test-v2.mjs
```

`data/imgcache/` 丢了不用管，访问时会自动重新生成。
