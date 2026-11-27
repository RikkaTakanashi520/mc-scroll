/**
 * 本地预览静态版（模拟 GitHub/Cloudflare Pages）
 *
 * 为什么需要它：静态版和 Node 版的行为差异主要在文件路径和压缩上，
 * 直接用 file:// 打开会因 ES module 的 CORS 限制失败。
 * 这个小服务器复制了 Pages 的两个关键行为：
 *   1. 支持 .br 文件（Cloudflare 自动选，GitHub 不认但不报错）
 *   2. 目录路径回落到 index.html
 *
 * 用法: node scripts/serve-static.mjs
 *       node scripts/serve-static.mjs --port 5000 --dir docs
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PORT = Number(val('--port', '5000'));
const DIR = path.resolve(ROOT, val('--dir', 'dist'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.br': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/' || rel === '') rel = '/index.html';

    let file = path.join(DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(DIR)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    // 目录回落到 index.html
    const info = await stat(file).catch(() => null);
    if (info?.isDirectory()) file = path.join(file, 'index.html');

    // 有 .br 就优先给 .br（模拟 Cloudflare Pages 的自动协商）
    const acceptsBr = /br/.test(req.headers['accept-encoding'] || '');
    if (acceptsBr) {
      const brFile = file + '.br';
      const brInfo = await stat(brFile).catch(() => null);
      if (brInfo?.isFile()) {
        const data = await readFile(brFile);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Encoding': 'br',
          'Content-Length': data.length,
          'Cache-Control': 'public, max-age=300',
        });
        res.end(data);
        return;
      }
    }

    const data = await readFile(file).catch(() => null);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(data);
  } catch (err) {
    res.writeHead(500).end(String(err.message));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`静态预览: http://127.0.0.1:${PORT}/`);
  console.log(`目录: ${DIR}`);
  console.log('（这是纯静态服务器，行为与 GitHub/Cloudflare Pages 一致）');
});
