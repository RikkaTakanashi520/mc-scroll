/**
 * 图片代理 + 缩略图生成
 *
 * 为什么需要：
 *   Modrinth CDN 只给「gallery 截图」提供 _350.webp 缩略图（约 60KB）。
 *   但项目正文里引用的图片（约占 31% 的项目首图）没有缩略图，只能拿到 1~2MB 原图，
 *   刷流时首屏要等好几秒 —— 这是"刷新慢"的主要根因。
 *
 * 方案：后端代理，按需缩放并输出 WebP，落盘缓存。
 *   - 首次：下载 → Pillow 缩放 → 存 WebP → 返回
 *   - 之后：直读缓存（1ms 级）
 *   - 同 URL 并发只下载一次
 *
 * 为什么用 Pillow 而不是 sharp：
 *   环境里没有 sharp，装它需要原生编译；bundled Python 自带 Pillow，零安装成本。
 *
 * 为什么用一次性子进程而不是常驻：
 *   常驻进程需要自定义二进制协议，容易写错且难调试（第一版就写崩了）。
 *   图片缩放本身极快（<100ms），Python 冷启动 ~200ms 可以接受；
 *   真正的性能来自**磁盘缓存**——第二次起就是 1ms。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, '..', 'data', 'imgcache');

const UA = 'mc-scroll/0.1 (image proxy)';

// 只允许代理这些图床，避免服务被当成任意 URL 代理滥用
const ALLOWED_HOSTS = new Set([
  'cdn.modrinth.com',
  'media.forgecdn.net',
  'i.imgur.com',
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com',
  'media.discordapp.net',
  'cdn.discordapp.com',
  'i.ibb.co',
]);

const MAX_SRC_BYTES = 12 * 1024 * 1024;
const inflight = new Map();

// 失败过的 URL 记下来，短时间内不再重试，避免每次都卡一个超时
const failures = new Map(); // srcUrl -> { at, reason }
const FAIL_TTL = 10 * 60_000;

/**
 * 上游并发闸门。
 *
 * 为什么需要：首屏 10 张图里若有 5 张没缓存，会有 5 个「下载+缩放」同时跑，
 * 每个都去抢 CDN 带宽和 Python 进程，结果谁都慢，最慢的一直顶到 8 秒超时。
 * 限流后单张成功率明显提高，整体首屏反而更快。
 */
const MAX_UPSTREAM = 4;
let activeUpstream = 0;
const waiters = [];

async function acquireSlot() {
  if (activeUpstream < MAX_UPSTREAM) {
    activeUpstream++;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve));
  activeUpstream++;
}

function releaseSlot() {
  activeUpstream = Math.max(0, activeUpstream - 1);
  const next = waiters.shift();
  if (next) next();
}

function isAllowed(u) {
  try {
    return ALLOWED_HOSTS.has(new URL(u).hostname);
  } catch {
    return false;
  }
}

const keyOf = (url, w) => createHash('sha1').update(`${url}|${w}`).digest('hex');

/** 调 Python + Pillow 把图片缩到指定宽度并存成 WebP */
function resizeToWebp(inputBuf, width) {
  return new Promise((resolve, reject) => {
    const py = process.env.MC_SCROLL_PYTHON || 'python';
    const script = `
import sys, io
from PIL import Image
width = int(sys.argv[1])
buf = sys.stdin.buffer.read()
try:
    im = Image.open(io.BytesIO(buf))
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGB")
    w, h = im.size
    if w > width:
        im = im.resize((width, max(1, round(h * width / w))), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, format="WEBP", quality=76, method=4)
    sys.stdout.buffer.write(out.getvalue())
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(2)
`;
    const proc = spawn(py, ['-c', script, String(width)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const outChunks = [];
    const errChunks = [];
    proc.stdout.on('data', (d) => outChunks.push(d));
    proc.stderr.on('data', (d) => errChunks.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0 && outChunks.length) resolve(Buffer.concat(outChunks));
      else reject(new Error(`pillow ${code}: ${Buffer.concat(errChunks).toString().slice(0, 120)}`));
    });
    proc.stdin.on('error', () => {});
    proc.stdin.write(inputBuf);
    proc.stdin.end();
  });
}

/** 从 GIF 里取第一帧，缩成 WebP（用于大动图的刷流缩略图） */
function resizeGifFrameToWebp(inputBuf, width) {
  return new Promise((resolve, reject) => {
    const py = process.env.MC_SCROLL_PYTHON || 'python';
    const script = `
import sys, io
from PIL import Image
width = int(sys.argv[1])
buf = sys.stdin.buffer.read()
try:
    im = Image.open(io.BytesIO(buf))
    im.seek(0)                     # 只取第一帧
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGB")
    w, h = im.size
    if w > width:
        im = im.resize((width, max(1, round(h * width / w))), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, format="WEBP", quality=76, method=4)
    sys.stdout.buffer.write(out.getvalue())
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(2)
`;
    const proc = spawn(py, ['-c', script, String(width)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const outChunks = [];
    const errChunks = [];
    proc.stdout.on('data', (d) => outChunks.push(d));
    proc.stderr.on('data', (d) => errChunks.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0 && outChunks.length) resolve(Buffer.concat(outChunks));
      else reject(new Error(`gif frame ${code}: ${Buffer.concat(errChunks).toString().slice(0, 120)}`));
    });
    proc.stdin.on('error', () => {});
    proc.stdin.write(inputBuf);
    proc.stdin.end();
  });
}

/**
 * 取缩略图。
 * @returns {{buf: Buffer, contentType: string, cache: 'hit'|'miss'|'fallback'}}
 */
export async function getThumb(srcUrl, width = 640) {
  if (!isAllowed(srcUrl)) {
    const err = new Error('host_not_allowed');
    err.code = 'HOST';
    throw err;
  }

  // 已知失败的直接拒绝，别让用户每次等 10 秒超时
  const fail = failures.get(srcUrl);
  if (fail && Date.now() - fail.at < FAIL_TTL) {
    const err = new Error(`known_failure:${fail.reason}`);
    err.code = 'KNOWN_FAIL';
    throw err;
  }

  const w = Math.min(Math.max(Number(width) || 640, 160), 1280);
  const file = path.join(CACHE_DIR, `${keyOf(srcUrl, w)}.webp`);

  // 1) 缓存命中
  try {
    const st = await stat(file);
    if (st.size > 0) {
      return { buf: await readFile(file), contentType: 'image/webp', cache: 'hit' };
    }
  } catch {}

  // 2) 并发去重
  const key = `${keyOf(srcUrl, w)}`;
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    await acquireSlot();
    try {
      const res = await fetch(srcUrl, {
        headers: { 'User-Agent': UA, Accept: 'image/*' },
        // 15 秒：原图常有 1~4MB，8 秒偶发不够（实测 1.8MB 的图会撞线）
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`upstream_${res.status}`);

      const declared = Number(res.headers.get('content-length') || 0);
      if (declared > MAX_SRC_BYTES) throw new Error('too_large');

      const src = Buffer.from(await res.arrayBuffer());
      if (src.length > MAX_SRC_BYTES) throw new Error('too_large');

      const ct = res.headers.get('content-type') || '';

      // GIF 动图处理：
      //   小 GIF（<800KB）原样透传，动效保留；
      //   大 GIF 只取第一帧压成静态 WebP —— 实测有些 GIF 到 4.5MB，
      //   刷流时每张卡都挂一个 4.5MB 的动图，首屏直接崩（实测 2 秒以上）。
      //   卡片上静止的第一帧已经足够表达内容，点开灯箱才加载原动图。
      if (ct.includes('gif')) {
        if (src.length <= 800 * 1024) {
          return { buf: src, contentType: ct, cache: 'fallback' };
        }
        try {
          const frame = await resizeGifFrameToWebp(src, w);
          if (frame && frame.length) {
            await mkdir(CACHE_DIR, { recursive: true });
            await writeFile(file, frame);
            return { buf: frame, contentType: 'image/webp', cache: 'miss' };
          }
        } catch {
          /* 取帧失败就退回原图 */
        }
        return { buf: src, contentType: ct, cache: 'fallback' };
      }

      let out;
      try {
        out = await resizeToWebp(src, w);
      } catch {
        // Pillow 不可用时退回原图，保证图还能看到
        return { buf: src, contentType: ct || 'image/png', cache: 'fallback' };
      }

      // 缩放后反而更大就用原图（小图常见）
      if (out.length >= src.length) {
        return { buf: src, contentType: ct || 'image/png', cache: 'fallback' };
      }

      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(file, out);
      return { buf: out, contentType: 'image/webp', cache: 'miss' };
    } finally {
      releaseSlot();
    }
  })();

  inflight.set(key, task);
  try {
    return await task;
  } catch (err) {
    // 只有「确定性失败」（404、太大、域名不允许）才进黑名单。
    //
    // 超时和网络抖动是临时的，记进去会让这张图 10 分钟内都出不来——
    // 实测有张 1.8MB 的图偶尔超 8 秒，一旦被拉黑，用户刷新也看不到。
    const msg = String(err.message || '');
    const transient = /timeout|aborted|fetch failed|ECONN|ETIMEDOUT|socket/i.test(msg);
    if (!transient) {
      failures.set(srcUrl, { at: Date.now(), reason: msg.slice(0, 40) });
    }
    if (failures.size > 5000) {
      const cutoff = Date.now() - FAIL_TTL;
      for (const [k, v] of failures) if (v.at < cutoff) failures.delete(k);
    }
    throw err;
  } finally {
    inflight.delete(key);
  }
}

/** 预热：后台把一组 URL 的缩略图先做出来（用于提高首屏命中率） */
export async function warmup(urls, width = 640) {
  let ok = 0;
  for (const u of urls) {
    try {
      await getThumb(u, width);
      ok++;
    } catch {}
  }
  return ok;
}
