/**
 * 文案字典（中英双语）
 *
 * 翻译原则（这是我自己审出来的几条规矩）：
 *   1. **专有名词不翻**：Modrinth / Fabric / NeoForge / Forge / Datapack 等
 *      是社区通用叫法，翻成「整合包加载器」反而增加理解成本。只翻通用词。
 *   2. **术语用国内 MC 圈的实际说法**，不照搬字典：
 *      - mod → 模组（不是「模块」）
 *      - modpack → 整合包（不是「模组包」）
 *      - datapack → 数据包
 *      - resource pack → 资源包
 *      - shader → 光影（不是「着色器」，那是图形学术语）
 *      - worldgen → 地形生成
 *      - optimization → 优化
 *      - library → 前置库（社区说法）
 *      - kitchen-sink → 大杂烩
 *      - quests → 任务（不是「任务线」）
 *      - cursed → 整活（社区黑话，指怪异内容）
 *   3. **按钮文案要短**：中文按钮比英文长，超过 4 字容易换行，所以「查看原站」
 *      这种比「在 Modrinth 上查看」更合适。
 *   4. **数量单位中文化**：1.2M → 120 万（国内用户不习惯 M/K 缩写）。
 *   5. **不硬翻的句子**：像 "Cat in hud based on oneko.js" 这种项目简介是作者原文，
 *      属于内容而非界面，保持原文不翻（翻了就成了「译者的话」）。
 */

export const LANGS = [
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'zh', label: '简体中文', short: '中' },
];

/** 界面文案 */
const DICT = {
  en: {
    // 导航与通用
    browse: 'Browse',
    allProjects: 'All projects',
    categories: 'Categories',
    // 中文用「模组分类」而不是「模组 · 分类」——后者是英文拼接思维，中文读着别扭
    categoriesOf: (type) => `${type} categories`,
    loaders: 'Loaders',
    gameVersion: 'Game version',
    releasesMulti: (n) => `${n} releases · multi-select`,
    allVersions: (n) => `All ${n} versions →`,
    types: 'Project type',
    contentQuality: 'Content quality',
    onlyWithImages: 'Only with screenshots',
    saved: 'Saved',
    // ---- 快捷键面板 ----
    shortcuts: 'Keyboard shortcuts',
    keysFeed: 'Browse content',
    keysImage: 'Screenshots',
    keysDetail: 'Right panel',
    keysAction: 'Actions',
    nextCard: 'Next project',
    prevCard: 'Previous project',
    nextImage: 'Next screenshot',
    prevImage: 'Previous screenshot',
    detailDown: 'Scroll panel down',
    detailUp: 'Scroll panel up',
    toggleDetail: 'Collapse / expand panel',
    collapseDetail: 'Collapse panel',
    expandDetail: 'Expand panel',
    detailCollapsed: 'Panel is collapsed — press \\ to expand',
    openPage: 'Open on Modrinth',
    openDetail: 'Open details',
    openFilters: 'Open filters',
    openSearch: 'Search',
    openSaved: 'Open saved',
    showShortcuts: 'Toggle this panel',
    closeLayer: 'Close current layer',
    keysNumpadHint: 'Click any row to rebind. Arrow keys and numpad both work (numpad needs NumLock on).',
    keysPress: 'Press a key…',
    keysConflict: 'conflict',
    keysResetAll: 'Restore defaults',
    keysReset: 'Shortcuts restored to defaults',
    keysSaved: (k) => `Bound to ${k}`,
    savedTitle: 'My saved',
    save: 'Save',
    filters: 'Filters',
    reset: 'Reset',
    applyFilters: 'Apply filters',
    clear: 'Clear',
    search: 'Search',
    searchPlaceholder: 'Search mods, modpacks, datapacks…',
    close: 'Close',
    back: 'Back',
    previous: 'Previous',
    next: 'Next',
    copy: 'Copy',
    open: 'Open',
    details: 'Details',
    viewOnModrinth: 'View on Modrinth',
    noData: 'No data',

    // 详情栏 / 抽屉
    stats: 'Stats',
    downloads: 'Downloads',
    followers: 'Followers',
    license: 'License',
    updated: 'Updated',
    about: 'About',
    links: 'Links',
    noScreenshots: 'No screenshots',
    none: 'None',
    allGameVersions: (n) => `All game versions (${n})`,
    gameVersionsHeading: (n) => `Game versions (${n})`,
    gameVersionsCount: (n, latest) =>
      n ? `${n} total${latest ? ` (latest ${latest})` : ''}` : '—',

    // 徽章
    popular: 'Popular',

    // 提示
    toastSaved: 'Saved',
    toastRemoved: 'Removed from saved',
    toastCleared: 'Cleared',
    toastLinkCopied: 'Link copied',
    toastCopyFailed: 'Copy failed',
    toastNoResults: 'No results for these filters',
    toastLoadFailed: 'Failed to load feed',
    toastDetailFailed: 'Could not load details',
    toastSearchFailed: 'Search failed',
    toastSearchHint: 'Search by name, e.g. “create”, “sodium”, “terralith”',
    toastNoResultsFor: (q) => `No results for “${q}”`,
    toastSearching: 'Searching…',
    emptySaved: 'Nothing saved yet. Tap the star to keep something.',
    emptyScroll: 'Scroll to load content',
    confirmClear: 'Clear all saved items?',

    // 致命错误
    fatalEmpty: 'Database is empty. Run the crawler first.',
    fatalNoApi: 'Cannot reach the API server. Start it with: node server/index.mjs',

    // 语言切换
    language: 'Language',
  },

  zh: {
    browse: '浏览',
    allProjects: '全部项目',
    categories: '分类',
    categoriesOf: (type) => `${type}分类`,
    loaders: '加载器',
    gameVersion: '游戏版本',
    releasesMulti: (n) => `共 ${n} 个正式版 · 可多选`,
    allVersions: (n) => `全部 ${n} 个版本 →`,
    types: '项目类型',
    contentQuality: '内容质量',
    onlyWithImages: '只看有截图的',
    // 收藏按钮的两种状态。
    // 英文能靠 Save/Saved 区分，中文必须显式区分「收藏 / 已收藏」，
    // 否则按钮点了没反馈（第一版就翻成两个「收藏」，实测看不出状态）。
    saved: '已收藏',
    // ---- 快捷键面板 ----
    shortcuts: '快捷键',
    keysFeed: '浏览内容',
    keysImage: '截图切换',
    keysDetail: '右侧详情',
    keysAction: '操作',
    nextCard: '下一个项目',
    prevCard: '上一个项目',
    nextImage: '下一张截图',
    prevImage: '上一张截图',
    detailDown: '详情向下滚',
    detailUp: '详情向上滚',
    toggleDetail: '折叠 / 展开详情',
    collapseDetail: '折叠详情',
    expandDetail: '展开详情',
    detailCollapsed: '详情已折叠，按 \\ 展开',
    openPage: '打开 Modrinth 页面',
    openDetail: '打开详情',
    openFilters: '打开筛选',
    openSearch: '搜索',
    openSaved: '打开收藏',
    showShortcuts: '开关这个面板',
    closeLayer: '关闭当前浮层',
    keysNumpadHint: '点任意一行即可改键。方向键和小键盘都能用（小键盘需开启 NumLock）。',
    keysPress: '请按键…',
    keysConflict: '冲突',
    keysResetAll: '恢复默认',
    keysReset: '快捷键已恢复默认',
    keysSaved: (k) => `已绑定到 ${k}`,
    // 列表页标题用「我的收藏」，和按钮上的「已收藏」区分开——
    // 同一句用在两处会读着别扭（实测截图里标题显示「已收藏」很怪）
    savedTitle: '我的收藏',
    save: '收藏',
    filters: '筛选',
    reset: '重置',
    applyFilters: '应用筛选',
    clear: '清空',
    search: '搜索',
    searchPlaceholder: '搜索模组、整合包、数据包…',
    close: '关闭',
    back: '返回',
    previous: '上一张',
    next: '下一张',
    copy: '复制',
    open: '打开',
    details: '详情',
    viewOnModrinth: '前往 Modrinth',
    noData: '没有数据',

    stats: '数据',
    downloads: '下载量',
    followers: '关注数',
    license: '开源许可',
    updated: '更新时间',
    about: '关于',
    links: '相关链接',
    noScreenshots: '暂无截图',
    none: '无',
    allGameVersions: (n) => `全部游戏版本（${n}）`,
    gameVersionsHeading: (n) => `游戏版本（${n}）`,
    gameVersionsCount: (n, latest) => (n ? `共 ${n} 个（最新 ${latest}）` : '—'),

    popular: '热门',

    toastSaved: '已收藏',
    toastRemoved: '已取消收藏',
    toastCleared: '已清空',
    toastLinkCopied: '链接已复制',
    toastCopyFailed: '复制失败',
    toastNoResults: '当前筛选条件下没有内容',
    toastLoadFailed: '内容加载失败',
    toastDetailFailed: '详情加载失败',
    toastSearchFailed: '搜索失败',
    toastSearchHint: '输入名称搜索，例如「create」「sodium」「terralith」',
    toastNoResultsFor: (q) => `没有找到「${q}」`,
    toastSearching: '搜索中…',
    emptySaved: '还没有收藏，刷到喜欢的点星标收藏。',
    emptyScroll: '下滑加载内容',
    confirmClear: '确定清空所有收藏？',

    fatalEmpty: '数据库是空的，请先运行抓取脚本。',
    fatalNoApi: '连不上 API 服务，请先运行：node server/index.mjs',

    language: '语言',
  },
};

/**
 * 项目类型名（频道名）。
 * Datapack / Plugin 这类在中文里也常直接用英文，但为了界面统一还是给中文。
 */
const TYPE_DICT = {
  en: {
    mod: 'Mod',
    modpack: 'Modpack',
    datapack: 'Datapack',
    resourcepack: 'Resource Pack',
    shader: 'Shader',
    plugin: 'Plugin',
    minecraft_java_server: 'Server',
  },
  zh: {
    mod: '模组',
    modpack: '整合包',
    datapack: '数据包',
    resourcepack: '资源包',
    shader: '光影',
    plugin: '服务端插件',
    minecraft_java_server: '服务器',
  },
};

/**
 * 分类名（Modrinth taxonomy）。
 *
 * 取舍：只翻「有明确中文说法」的，其余保留英文——半吊子翻译比不翻更糟。
 * 典型保留英文的几类：
 *   - 分辨率 16x/32x/128x：直接是数字，翻了没意义
 *   - Environment / Realistic / Simplistic / Vanilla Like：形容词类，
 *     中文社区一般直接说「写实风」「原版风」，但作为标签短词反而英文更清楚
 *   - Atmosphere / Bloom / PBR / Reflections：光影技术术语，玩家圈通用英文
 */
const CATEGORY_DICT = {
  adventure: '冒险',
  cursed: '整活',
  decoration: '装饰',
  economy: '经济',
  equipment: '装备',
  food: '食物',
  'game-mechanics': '游戏机制',
  library: '前置库',
  magic: '魔法',
  management: '管理',
  minigame: '小游戏',
  mobs: '生物',
  optimization: '优化',
  social: '社交',
  storage: '存储',
  technology: '科技',
  transportation: '交通',
  utility: '实用',
  worldgen: '地形生成',
  // modpack
  challenging: '硬核',
  combat: '战斗',
  'kitchen-sink': '大杂烩',
  lightweight: '轻量',
  multiplayer: '多人',
  quests: '任务',
  // resourcepack / shader 里少数有公认说法的
  blocks: '方块',
  items: '物品',
  entities: '实体',
  fonts: '字体',
  gui: '界面',
  audio: '音效',
  'core-shaders': '核心光影',
  'vanilla-like': '原版风',
  realistic: '写实风',
  simplistic: '简约风',
  themed: '主题风格',
  tweaks: '细节调整',
  modded: '模组兼容',
  cartoon: '卡通',
  fantasy: '奇幻',
  'semi-realistic': '半写实',
  pbr: 'PBR 材质',
  'path-tracing': '路径追踪',
  shadows: '阴影',
  bloom: '泛光',
  reflections: '反射',
  atmosphere: '大气',
  foliage: '植被',
  'colored-lighting': '彩色光',
  // 性能档位
  potato: '土豆机',
  low: '低配',
  medium: '中配',
  high: '高配',
  screenshot: '截图党',
};

let current = 'en';

export function setLang(code) {
  current = DICT[code] ? code : 'en';
  return current;
}

export function getLang() {
  return current;
}

/**
 * 取文案。
 * 用法：t('saved')  或  t('allVersions', 103)
 */
export function t(key, ...args) {
  const v = DICT[current]?.[key] ?? DICT.en[key];
  if (typeof v === 'function') return v(...args);
  return v ?? key;
}

/** 项目类型显示名 */
export function typeLabel(type) {
  return TYPE_DICT[current]?.[type] ?? TYPE_DICT.en[type] ?? type;
}

/** 分类显示名；没有翻译时回退成「首字母大写」的英文原词 */
export function categoryLabel(name, { titleCase } = {}) {
  if (current === 'zh' && CATEGORY_DICT[name]) return CATEGORY_DICT[name];
  return titleCase ? titleCase(name) : name;
}

/**
 * 数字格式化。
 *
 * 中文习惯「万/亿」，英文习惯 K/M/B——所以这里必须按语言分支，
 * 不能只换单位（1.2M 换成「1.2 百万」是灾难）。
 */
export function fmtNum(n, lang = current) {
  const v = Number(n) || 0;
  if (lang === 'zh') {
    if (v >= 1e8) return `${(v / 1e8).toFixed(v >= 1e9 ? 0 : 1)} 亿`;
    if (v >= 1e4) return `${(v / 1e4).toFixed(v >= 1e6 ? 0 : 1)} 万`;
    return String(v);
  }
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}K`;
  return String(v);
}
