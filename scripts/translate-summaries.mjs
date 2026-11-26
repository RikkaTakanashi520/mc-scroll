/**
 * 项目简介翻译（英文 → 中文）
 *
 * 为什么需要单独一步：
 *   界面文案在 js/i18n.js 里手写；但 16 万个项目的简介是作者原文，
 *   只能在抓取后批量翻译并落库，运行时按语言取对应字段。
 *
 * 术语纠正表（POLISH）是我审出来的，不是机翻原样：
 *   机翻对 MC 圈的专有叫法经常出错，必须替换，否则读起来不像人话。
 *
 * 用法:
 *   node scripts/translate-summaries.mjs --limit 2000     # 先翻 2000 条试水
 *   node scripts/translate-summaries.mjs                 # 翻全部（可断点续传）
 *   node scripts/translate-summaries.mjs --type mod      # 只翻某个类型
 *   node scripts/translate-summaries.mjs --apply-only    # 只回填缓存，不发请求
 */
import { createHash } from 'node:crypto';
import { openDb, tx } from '../server/db.mjs';

const args = process.argv.slice(2);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const has = (f) => args.includes(f);

const LIMIT = Number(val('--limit', '1000000'));
const TYPE = val('--type', null);
const CONCURRENCY = Number(val('--concurrency', '3'));
const BATCH = Number(val('--batch', '12'));
/**
 * 单次请求的总字符上限。
 *
 * 实测（见下方结论）：接口对「一次请求里所有文本的总长度」有硬限制，
 *   12 × 900 = 10800 字符 → outOfLimit
 *    6 × 900 =  5400 字符 → succ
 * 所以不能只按「条数」分批。简介（约 80 字符）一批 12 条没问题，
 * 但正文（平均 683、最长 900）按条数分批必然超限。
 *
 * 这里改成按**字符预算**动态组批，上限取 5000（留足余量）。
 */
const MAX_CHARS_PER_REQUEST = 4800;
const APPLY_ONLY = has('--apply-only');

const key = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isZh = (s) => /[\u4e00-\u9fa5]/.test(s || '');

/**
 * 机翻结果纠正。
 *
 * 每一条都来自真实抽查到的问题（不是猜的）。
 * 最严重的几类是**把游戏专有名词当普通词翻译**：
 *   mod   被翻成「国防部」← Department of Defense，出现频率最高
 *   Create 被翻成「创建」← 它是模组名，不是动词
 *   Sodium 被翻成「钠」← 它是模组名，不是化学元素
 *   mace  被翻成「梅斯」← 应为「重锤 / 锤」
 *   Sculk 被翻成「幽匿」之外的各种奇怪词
 */
const POLISH = [
  // ---- 最严重的：专有名词被当地普通词 ----
  [/国防部/g, '模组'],
  [/国防部的/g, '模组的'],
  [/模方块/g, '模组'],
  [/创建模组/g, 'Create 模组'],
  [/创建航空/g, 'Create Aeronautics'],
  [/钠选项/g, 'Sodium 选项'],
  [/应用能源学/g, '应用能源'],
  [/梅斯/g, '重锤'],
  [/魔方/g, '模组'],
  [/改装纹理/g, '模组化纹理'],
  [/改装模组/g, '模组'],

  // ---- 模组名被当成普通词翻译 ----
  //
  // 这一类最容易翻车：名字本身就是常用词，无脑全局替换会把正常句子改坏。
  // 例：「创建您自己的硬币」是正常动词，不能变成「Create 您自己的硬币」。
  // 所以只匹配**明显的专有名词上下文**，逐条看过真实译文才敢加。
  [/与钠兼容/g, '与 Sodium 兼容'],
  [/单独钠/g, '单独 Sodium'],
  [/钠\/嵌入/g, 'Sodium/Embeddium'],
  [/钠和嵌入/g, 'Sodium 和 Embeddium'],
  [/钠、Optifine/g, 'Sodium、OptiFine'],
  [/钠额外移植版/g, 'Sodium Extra 移植版'],
  [/钠矿物模型/g, 'Sodium 矿物模型'],
  [/钠的替代选项菜单/g, 'Sodium 的替代选项菜单'],
  [/兼容钠/g, '兼容 Sodium'],
  [/嵌入、光圈/g, 'Embeddium、Iris'],
  [/光圈和着色器/g, 'Iris 和光影'],
  [/（新）锻造/g, '（新版）Forge'],
  [/（新\/锻造）/g, '（新版/Forge）'],
  [/(?<![以可])用于创建(?=[，,])/g, '用于 Create'],
  [/与创建兼容/g, '与 Create 兼容'],
  [/兼容创建/g, '兼容 Create'],
  [/创建插件/g, 'Create 插件'],
  [/创建支持/g, 'Create 支持'],
  [/创建和相关模组/g, 'Create 和相关模组'],
  [/创建，Minecolonies/g, 'Create、Minecolonies'],

  // Fabric / Forge / Iris / Sodium 的其余高频上下文
  // （逐条摘自真实译文，见上方抽样）
  [/织物模组/g, 'Fabric 模组'],
  [/织物生存/g, 'Fabric 生存'],
  [/织物季节/g, 'Fabric 季节'],
  [/对于织物/g, '对于 Fabric'],
  [/织物\+/g, 'Fabric+'],
  [/\|织物/g, '|Fabric'],
  [/织物服务端/g, 'Fabric 服务端'],
  [/织物版本/g, 'Fabric 版本'],
  // 「锻造台」是正常游戏术语（anvil/forge table），不能被后面的规则改成 Forge。
  // 用负向断言排除，而不是先替换成自己（那是无效操作）。
  [/(?<!在)锻造台/g, '锻造台'],
  [/锻造港口/g, 'Forge 移植版'],
  [/锻造版本/g, 'Forge 版本'],
  [/锻造1\./g, 'Forge 1.'],
  [/锻造上/g, 'Forge 上'],
  [/(?<!在)的锻造/g, '的 Forge'],
  [/虹膜着色器/g, 'Iris 光影'],
  [/虹膜分叉/g, 'Iris 分支'],
  [/虹膜shaderpack/g, 'Iris 光影包'],
  [/和虹膜/g, '和 Iris'],
  [/、虹膜/g, '、Iris'],
  [/虹膜，/g, 'Iris，'],
  [/不含钠/g, '不含 Sodium'],
  [/更好的钠/g, '更好的 Sodium'],
  [/钠\/虹膜/g, 'Sodium/Iris'],
  [/钠，锂/g, 'Sodium、Lithium'],
  [/钠、锂/g, 'Sodium、Lithium'],
  [/与钠配合/g, '与 Sodium 配合'],
  [/钠和/g, 'Sodium 和'],
  [/钠配置/g, 'Sodium 配置'],

  // ---- 加载器并列语境（覆盖剩余高频模式） ----
  //
  // 「织物」和「锻造」往往成对出现在「支持哪些加载器」的句子里：
  // 「适用于锻造和织物」「可用于锻造和织物」「织物，锻造和NeoForge」
  // 这类并列结构几乎必然是加载器名，可以放心替换。
  [/锻造和织物/g, 'Forge 和 Fabric'],
  [/织物和锻造/g, 'Fabric 和 Forge'],
  [/织物，锻造/g, 'Fabric、Forge'],
  [/锻造，织物/g, 'Forge、Fabric'],
  [/适用于锻造/g, '适用于 Forge'],
  [/可用于锻造/g, '可用于 Forge'],
  [/适用于织物/g, '适用于 Fabric'],
  [/可用于织物/g, '可用于 Fabric'],
  [/非官方织物移植版/g, '非官方 Fabric 移植版'],
  [/织物整合包/g, 'Fabric 整合包'],
  [/织物服务器/g, 'Fabric 服务器'],
  [/织物配置/g, 'Fabric 配置'],
  [/织物模式/g, 'Fabric 模组'],
  [/锻造模式/g, 'Forge 模组'],
  [/一个织物模/g, '一个 Fabric 模'],
  [/一个锻造模/g, '一个 Forge 模'],
  [/织物新材料/g, 'Fabric 新材料'],
  [/织物上/g, 'Fabric 上'],
  [/织物！/g, 'Fabric！'],
  [/织物。/g, 'Fabric。'],
  [/织物、/g, 'Fabric、'],
  [/织物1\./g, 'Fabric 1.'],
  // 注意：不要加「任何位置的织物/锻造都替换」这种兜底规则。
  // 实测会误伤正常中文：「机织物锻造」「酿造，锻造，和生活质量」「纺织品和织物材料」
  // 都会被改坏。宁可漏改少数专有名词，也不能把正常句子改错。

  // ---- MC 术语 ----
  [/香草版本/g, '原版'],
  [/香草味的/g, '原版风格'],
  [/香草风/g, '原版风'],
  [/香草方块/g, '原版方块'],
  [/香草块/g, '原版方块'],
  [/香草/g, '原版'],
  [/暴徒/g, '生物'],
  [/老板遭遇/g, 'Boss 战'],
  [/老板/g, 'Boss'],
  [/生物群落/g, '生物群系'],
  [/模组包/g, '整合包'],
  [/生物产卵/g, '生物生成'],
  // spawn 在 MC 里是「生成」，机翻常给出生殖术语「产卵」；mob 常被翻成「暴民」
  [/产卵过滤器/g, '生成过滤器'],
  [/产卵/g, '生成'],
  [/暴民/g, '怪物'],
  [/结构产卵/g, '结构生成'],
  [/纹理包/g, '材质包'],
  [/纹理/g, '材质'],
  [/(?<!方)块(?!数)/g, '方块'],
  [/\bmodpack\b/gi, '整合包'],
  [/\bmods\b/gi, '模组'],
  [/\bmod\b/gi, '模组'],
  [/\bshader pack\b/gi, '光影包'],
  [/\bshaders\b/gi, '光影'],
  [/\bframe rate[s]?\b/gi, '帧数'],
  [/\bFPS\b/g, '帧数'],
  // 书名号：先剥掉已有的任意层（机翻有时自带《》，我的规则又加一层会套娃）
  [/《+我的世界》+/g, '我的世界'],
  [/我的世界(?!》)/g, '《我的世界》'],

  // ---- 机翻常见的生硬句式 ----
  [/所有在一个/g, '一体化的'],
  [/端口/g, '移植版'],
  [/多装载器/g, '多加载器'],

  // ---- 正文特有：Markdown/HTML 残留 ----
  // 正文是提取后的纯文本，但作者常内嵌 HTML 实体，机翻会原样保留，很难看。
  // 这里按出现频次从高到低覆盖（实测 &nbsp; 71 次、&emsp; 15 次、&eacute; 9 次）。
  [/&nbsp;/gi, ' '],
  [/&emsp;/gi, ' '],
  [/&thinsp;/gi, ' '],
  [/&amp;/gi, '&'],
  [/&lt;/gi, '<'],
  [/&gt;/gi, '>'],
  [/&quot;/gi, '"'],
  [/&apos;/gi, "'"],
  [/&eacute;/gi, 'é'],
  [/&egrave;/gi, 'è'],
  [/&agrave;/gi, 'à'],
  [/&uuml;/gi, 'ü'],
  [/&ouml;/gi, 'ö'],
  [/&auml;/gi, 'ä'],
  [/&szlig;/gi, 'ß'],
  [/&ccedil;/gi, 'ç'],
  // 兜底：剩下的数字实体和命名实体统一去掉，别显示成乱码
  [/&#\d+;/g, ''],
  [/&[a-z]{2,10};/gi, ''],

  // ---- 正文特有的术语误译（抽查见到的） ----
  [/卸载实体/g, 'DisMount Entity'], // 模组名，不是「卸载」
  [/鹅卵石镇/g, 'CobbleTowns'],
  [/鹅卵石怪物/g, 'Cobblemon'],
  [/刚好足够的项目/g, 'Just Enough Items'],
  [/音乐光盘/g, '音乐唱片'],
  [/车辆/g, '载具'],
  [/改装\)实体/g, '模组)实体'],
];

/** 明显翻坏的直接丢弃，宁可回退英文，也不要给用户看狗屁不通的句子 */
const BAD = /香草|暴徒|老板|USED ALL AVAILABLE|MYMEMORY WARNING|QUERY LENGTH/i;

function polish(text) {
  let out = String(text || '').replace(/\s+/g, ' ').trim();
  for (const [re, to] of POLISH) out = out.replace(re, to);
  return out;
}

async function translateBatch(texts) {
  // client_key 走环境变量，不硬编码进仓库。
  // 这个值是翻译服务网页端用的公开标识，泄露风险不高，
  // 但开源项目里放第三方服务凭据是不好的示范，也不方便以后换 provider。
  const clientKey = process.env.MC_TRANSLATE_KEY || '';
  if (!clientKey) throw new Error('MC_TRANSLATE_KEY 未设置');

  const res = await fetch('https://transmart.qq.com/api/imt', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      Referer: 'https://transmart.qq.com/zh-CN/index',
    },
    body: JSON.stringify({
      header: {
        fn: 'auto_translation',
        client_key: clientKey,
      },
      type: 'plain',
      model_category: 'normal',
      text_domain: 'general',
      source: { lang: 'auto', text_list: texts },
      target: { lang: 'zh' },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // 服务端限流时返回 busy，可重试
  if (data?.header?.ret_code === 'busy') throw new Error('RETRY_BUSY');
  if (data?.header?.ret_code !== 'succ') throw new Error(data?.header?.ret_code || 'not-succ');
  const out = data.auto_translation || [];
  if (out.length !== texts.length) throw new Error(`RETRY_COUNT ${out.length}/${texts.length}`);
  return out;
}

/** 带重试的事务：翻译脚本和服务端同时写库时会出现 database is locked */
function txRetry(db, fn, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      return tx(db, fn);
    } catch (err) {
      if (!/locked|busy/i.test(err.message) || i === tries - 1) throw err;
      // 等一小段再试，让另一边的写事务先提交
      const until = Date.now() + 200 * (i + 1);
      while (Date.now() < until) {
        /* 同步等待，避免 async 打断事务语义 */
      }
    }
  }
}

async function main() {
  const db = openDb();

  // --reapply：只对缓存里已有的译文重新套用 POLISH 规则，不发任何网络请求。
  // 用途：发现新的机翻错误后，批量修正历史译文（16617 条约 2 秒）。
  if (has('--reapply')) {
    const all = db.prepare('SELECT hash, zh FROM translations').all();
    const upd = db.prepare('UPDATE translations SET zh = ? WHERE hash = ?');
    let changed = 0;
    txRetry(db, () => {
      for (const r of all) {
        const fixed = polish(r.zh);
        if (fixed !== r.zh) {
          upd.run(fixed, r.hash);
          changed++;
        }
      }
    });
    console.log(`重新纠正 ${changed}/${all.length} 条译文`);
    // 同步清空 projects 里对应的中文缓存，让下面的回填重新写入。
    // 两个字段都清：translations 是共用缓存的，纠正后两边都要重填。
    txRetry(db, () =>
      db.exec('UPDATE projects SET summary_zh = NULL, description_zh = NULL'),
    );
  }

  if (!APPLY_ONLY) {
    /**
     * 翻译哪个字段：
     *   summary     —— 一句话简介（默认）
     *   description —— 正文 / About（较长，平均 683 字符，最长 900）
     *
     * 两者共用同一张 translations 缓存表（按原文 hash 去重），
     * 所以相同文本不会重复翻译。
     */
    const FIELD = val('--field', 'summary');
    if (!['summary', 'description'].includes(FIELD)) {
      console.error('--field 只能是 summary 或 description');
      process.exitCode = 1;
      return;
    }
    const COL = FIELD; // 列名，直接拼接（已白名单校验）
    const COL_ZH = `${FIELD}_zh`;

    const where = [
      `p.${COL} IS NOT NULL`,
      `p.${COL} != ''`,
      `p.${COL_ZH} IS NULL`,
      'p.gallery_count > 0',
    ];
    const binds = [];
    if (TYPE) {
      where.push('p.project_type = ?');
      binds.push(TYPE);
    }
    const rows = db
      .prepare(
        `SELECT p.id, p.${COL} AS text FROM projects p
         WHERE ${where.join(' AND ')}
         ORDER BY p.downloads DESC
         LIMIT ?`,
      )
      .all(...binds, LIMIT);

    console.log(`待翻译 ${rows.length} 条项目${FIELD === 'summary' ? '简介' : '正文'}`);

    // 先筛掉命中缓存的，只对真正没翻过的发请求
    const cacheStmt = db.prepare('SELECT zh FROM translations WHERE hash = ?');
    const todo = [];
    let cached = 0;
    for (const r of rows) {
      if (isZh(r.text)) continue;
      const h = key(r.text);
      const hit = cacheStmt.get(h);
      if (hit) {
        cached++;
        continue;
      }
      todo.push({ id: r.id, text: r.text, hash: h });
    }
    console.log(`缓存命中 ${cached} 条，需要新翻 ${todo.length} 条`);

    const insStmt = db.prepare(
      'INSERT OR REPLACE INTO translations (hash, src, zh, provider, quality) VALUES (?, ?, ?, ?, ?)',
    );

    let done = 0;
    let failed = 0;
    const t0 = Date.now();
    let cursor = 0;

    /**
     * 按字符预算取下一批。
     * 而不是按固定条数——正文一条就 900 字符，12 条直接超限。
     */
    function nextBatch() {
      const batch = [];
      let chars = 0;
      while (cursor < todo.length && batch.length < BATCH) {
        const item = todo[cursor];
        const len = item.text.length;
        // 单条就超预算：单独成批（否则永远发不出去）
        if (batch.length > 0 && chars + len > MAX_CHARS_PER_REQUEST) break;
        batch.push(item);
        chars += len;
        cursor++;
      }
      return batch;
    }

    async function worker() {
      while (cursor < todo.length) {
        const batch = nextBatch();
        if (!batch.length) break;

        let out = null;
        for (let attempt = 0; attempt < 5 && !out; attempt++) {
          try {
            out = await translateBatch(batch.map((b) => b.text));
          } catch (err) {
            // outOfLimit 说明这批还是太大，拆半重试
            if (/outOfLimit/i.test(err.message) && batch.length > 1) {
              const half = Math.ceil(batch.length / 2);
              const rest = batch.splice(half);
              cursor -= rest.length; // 把后半段放回队列
              continue;
            }
            const retryable = /RETRY_|fetch failed|timeout|aborted|HTTP 5/i.test(err.message);
            if (retryable && attempt < 4) {
              await sleep(700 * (attempt + 1));
              continue;
            }
            failed += batch.length;
            if (attempt === 4) console.log(`\n  ! 批次失败: ${err.message}`);
          }
        }
        if (!out) continue;

        txRetry(db, () => {
          batch.forEach((b, i) => {
            const zh = polish(out[i]);
            // 翻坏的不入库，让它回退英文
            if (zh && !BAD.test(zh) && isZh(zh)) {
              insStmt.run(b.hash, b.text, zh, 'transmart', null);
              done++;
            } else {
              failed++;
            }
          });
        });

        // 边翻边回填：否则整轮跑完（40 分钟）之前，页面上一条中文都看不到
        if (done % 200 === 0) backfill(db, FIELD);

        const el = (Date.now() - t0) / 1000;
        const rate = done / Math.max(el, 1);
        const remain = (todo.length - done) / Math.max(rate, 0.1);
        process.stdout.write(
          `\r  翻译 ${done}/${todo.length} 失败 ${failed} | ${rate.toFixed(0)}/s 剩余 ${(remain / 60).toFixed(1)}min   `,
        );
        await sleep(100);
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log(`\n翻译完成: 成功 ${done}，失败 ${failed}`);
  }

  // ---- 回填到 projects ----
  // FIELD 在 if (!APPLY_ONLY) 块里声明，APPLY_ONLY 分支下拿不到，
  // 所以这里重新取一次（两个分支都要能回填）。
  const applyField = val('--field', 'summary');
  const applyCol = ['summary', 'description'].includes(applyField) ? applyField : 'summary';
  const n = backfill(db, applyCol);
  const browsable = db.prepare('SELECT COUNT(*) n FROM projects WHERE gallery_count > 0').get().n;
  const withZh = db
    .prepare(`SELECT COUNT(*) n FROM projects WHERE gallery_count > 0 AND ${applyCol}_zh IS NOT NULL`)
    .get().n;
  console.log(
    `\n最终: 可刷项目中 ${withZh}/${browsable} 有中文${applyCol === 'summary' ? '简介' : '正文'} ` +
      `(${((withZh / browsable) * 100).toFixed(1)}%)`,
  );
}

/**
 * 把 translations 里的译文回填到 projects.<field>_zh
 * @param {string} field 'summary' | 'description'（调用方已白名单校验）
 */
function backfill(db, field = 'summary') {
  const all = db.prepare('SELECT hash, zh FROM translations').all();
  const map = new Map(all.map((r) => [r.hash, r.zh]));
  // 只回填还没填过的，避免每次全表重写
  const projects = db
    .prepare(
      `SELECT id, ${field} AS txt FROM projects
       WHERE ${field} IS NOT NULL AND ${field} != '' AND ${field}_zh IS NULL`,
    )
    .all();
  const upd = db.prepare(`UPDATE projects SET ${field}_zh = ? WHERE id = ?`);
  let filled = 0;
  txRetry(db, () => {
    for (const p of projects) {
      const zh = map.get(key(p.txt));
      if (zh) {
        upd.run(zh, p.id);
        filled++;
      }
    }
  });
  return filled;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
