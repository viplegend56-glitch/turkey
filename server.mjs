// Local preview server: serves the site and runs the /api functions.
//   HOPE_RPC_URL=https://your-rpc node server.mjs
// Then open http://localhost:3000 (site) and http://localhost:3000/admin.html (config editor).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 3000;
const routes = {
  '/api/impact': () => import('./api/impact.js'),
  '/api/route-check': () => import('./api/route-check.js')
};
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const servable = new Set(['/index.html', '/admin.html', '/hope.config.json', '/impact.json']);
// The public site lives in docs/ (what GitHub Pages serves); the editor stays in this folder.
const inDocs = new Set(['/index.html', '/hope.config.json', '/impact.json']);

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (routes[u.pathname]) return (await routes[u.pathname]()).default(req, res);
    const p = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
    if (!servable.has(p)) { res.statusCode = 404; return res.end('Not found'); }
    const body = await readFile(path.join(dir, inDocs.has(p) ? 'docs' : '', p));
    res.setHeader('content-type', types[path.extname(p)] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    res.end(body);
  } catch (e) {
    console.error(e);
    res.statusCode = 500; res.end('Server error');
  }
}).listen(port, () => console.log(`Turkeycoin preview: http://localhost:${port}  (admin: http://localhost:${port}/admin.html)`));
