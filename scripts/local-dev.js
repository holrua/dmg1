'use strict';
/* Minimal local dev server that mimics the Vercel Node runtime:
 * - mounts /api/* handlers exactly like Vercel (req.query includes path params)
 * - serves /static from public/
 * Usage: npm run dev  (or PORT=4000 node scripts/local-dev.js)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

const routes = [
  { re: /^\/api\/jobs\/([^/]+)\/process$/, fn: require('../api/jobs/[id]/process.js') },
  { re: /^\/api\/jobs\/([^/]+)\/video$/, fn: require('../api/jobs/[id]/video.js') },
  { re: /^\/api\/jobs\/([^/]+)$/, fn: require('../api/jobs/[id]/index.js') },
  { re: /^\/api\/jobs$/, fn: require('../api/jobs/index.js') },
  { re: /^\/api\/upload$/, fn: require('../api/upload.js') },
  { re: /^\/api\/config$/, fn: require('../api/config.js') },
  { re: /^\/api\/cron$/, fn: require('../api/cron.js') },
];

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    req.query = Object.fromEntries(u.searchParams.entries());
    req.url = u.pathname + u.search;
    for (const r of routes) {
      const m = r.re.exec(u.pathname);
      if (m) {
        if (m[1] !== undefined) req.query.id = decodeURIComponent(m[1]);
        return await r.fn(req, res);
      }
    }
    const rel = u.pathname === '/' ? '/index.html' : u.pathname;
    const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
      return fs.createReadStream(file).pipe(res);
    }
    res.statusCode = 404;
    return res.end('Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal error: ' + e.message);
    } else {
      try { res.destroy(); } catch (_) {}
    }
  }
});

const port = parseInt(process.env.PORT || '3000', 10);
server.listen(port, () => console.log(`dmg local dev server → http://localhost:${port}`));
