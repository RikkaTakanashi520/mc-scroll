/**
 * 把静态产物发布到 gh-pages 分支
 *
 * 为什么不用 CI 抓数据：
 *   GitHub Actions 免费额度有限，全量抓取 + 补详情 + 翻译要 1.5 小时以上，
 *   实测跑 14 分钟还没进到构建阶段。而且数据库 654MB 也不该进仓库。
 *
 * 正确分工：
 *   本地：抓数据 → build-static 导出 dist/ → 推 gh-pages 分支（本脚本）
 *   CI  ：只负责把 gh-pages 的内容发布成 Pages 站点
 *
 * 用法：
 *   node scripts/publish-pages.mjs                    # 构建并推送
 *   node scripts/publish-pages.mjs --skip-build       # 用已有 dist/ 只推送
 *   node scripts/publish-pages.mjs --message "更新数据" # 自定义提交信息
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const SKIP_BUILD = has('--skip-build');
const MSG = val('--message', `chore: 更新静态站点 ${new Date().toISOString().slice(0, 10)}`);

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
}
function capture(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
}

/**
 * 把主仓库的 git 代理配置带进临时目录。
 *
 * 踩过的坑：gh-pages 是在临时目录里 git init 的，
 * 不会继承主仓库的 local 配置，国内网络下 push 直接连不上。
 * 这里显式读出来，用 -c 参数传给临时仓库的 git 命令。
 */
function proxyArgs() {
  const http = capture('git config --local --get http.proxy') || capture('git config --global --get http.proxy');
  const https = capture('git config --local --get https.proxy') || capture('git config --global --get https.proxy');
  const args = [];
  if (http) args.push(`-c http.proxy=${http}`);
  if (https) args.push(`-c https.proxy=${https}`);
  return args;
}

async function main() {
  const remote = capture('git remote get-url origin');
  if (!remote) {
    console.error('没有配置 origin 远程仓库，先 gh repo create 或 git remote add');
    process.exit(1);
  }
  console.log(`远程: ${remote}`);

  if (!SKIP_BUILD) {
    console.log('\n[1/4] 构建静态产物...');
    run('node scripts/build-static.mjs');
  } else {
    console.log('\n[1/4] 跳过构建，使用现有 dist/');
  }

  if (!existsSync(DIST)) {
    console.error('dist/ 不存在。先跑 node scripts/build-static.mjs');
    process.exit(1);
  }

  // 用临时目录做 gh-pages 的工作区，不污染主工作树
  console.log('\n[2/4] 准备 gh-pages 工作区...');
  const tmp = await mkdtemp(path.join(tmpdir(), 'mc-pages-'));
  console.log(`  临时目录: ${tmp}`);

  // 放进 .nojekyll，否则 GitHub Pages 会忽略下划线开头的文件
  await writeFile(path.join(DIST, '.nojekyll'), '');
  // CNAME 若存在则一起带上（自定义域名）
  const cname = path.join(ROOT, 'CNAME');
  if (existsSync(cname)) {
    await cp(cname, path.join(DIST, 'CNAME'));
  }

  await cp(DIST, tmp, { recursive: true });

  console.log('\n[3/4] 提交到 gh-pages...');
  const g = (cmd) => execSync(cmd, { cwd: tmp, encoding: 'utf8', stdio: 'inherit' });
  g('git init -q');
  g('git checkout -q -b gh-pages');
  g(`git add -A`);
  g(`git -c user.name="mc-scroll-bot" -c user.email="bot@local" commit -q -m ${JSON.stringify(MSG)}`);

  console.log('\n[4/4] 推送...');
  const px = proxyArgs().join(' ');
  if (px) console.log(`  使用代理: ${px}`);
  g(`git ${px} push -f ${remote} gh-pages`);

  await rm(tmp, { recursive: true, force: true });

  // 推断 Pages 地址
  const slug = capture('git remote get-url origin')
    .replace(/\.git$/, '')
    .split('/')
    .slice(-2);
  const [owner, repo] = slug;
  console.log('\n完成。');
  console.log(`  Pages 地址: https://${owner.toLowerCase()}.github.io/${repo}/`);
  console.log('  若首次部署，去 Settings → Pages 确认 Source 是 "GitHub Actions"');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
