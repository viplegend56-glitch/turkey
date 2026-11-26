// A stand-in for the few GitHub REST endpoints the admin panel uses, kept in memory.
// Tests pass `fake.fetch` to the panel; the browser test also serves it over HTTP.
import crypto from 'node:crypto';
import http from 'node:http';

const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
const blobSha = buf => crypto.createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex');

export class FakeGitHub {
  constructor({ repo = 'owner/hope', branch = 'main', token = 'test-token', files = {} } = {}) {
    Object.assign(this, { repo, branch, token, blobs: new Map(), trees: new Map(), commits: new Map(), calls: [], readOnly: false, raceOnce: null });
    this.head = this._commit(this._tree(this._store(files)), [], 'Initial upload');
  }
  _store(files) { const flat = {}; for (const [p, text] of Object.entries(files)) { const b = Buffer.from(text, 'utf8'); const s = blobSha(b); this.blobs.set(s, b); flat[p] = s; } return flat; }
  _tree(flat) {
    const dirs = {}, entries = [];
    for (const [p, s] of Object.entries(flat)) {
      const i = p.indexOf('/');
      if (i < 0) entries.push({ path: p, mode: '100644', type: 'blob', sha: s });
      else (dirs[p.slice(0, i)] = dirs[p.slice(0, i)] || {})[p.slice(i + 1)] = s;
    }
    for (const [d, sub] of Object.entries(dirs)) entries.push({ path: d, mode: '040000', type: 'tree', sha: this._tree(sub) });
    entries.sort((a, b) => (a.path < b.path ? -1 : 1));
    const s = sha1('tree' + JSON.stringify(entries));
    this.trees.set(s, entries);
    return s;
  }
  _flat(treeSha, prefix = '') {
    const out = {};
    for (const e of this.trees.get(treeSha) || []) {
      if (e.type === 'tree') Object.assign(out, this._flat(e.sha, prefix + e.path + '/')); else out[prefix + e.path] = e.sha;
    }
    return out;
  }
  _commit(tree, parents, message) { const s = sha1('commit' + tree + parents.join() + message + this.commits.size); this.commits.set(s, { tree, parents, message }); return s; }
  /** What a push from somewhere else looks like (the counter job, an upload on github.com). */
  push(files, message = 'Outside change') {
    const flat = Object.assign(this._flat(this.commits.get(this.head).tree), this._store(files));
    this.head = this._commit(this._tree(flat), [this.head], message);
  }
  file(p, commit = this.head) { const s = this._flat(this.commits.get(commit).tree)[p]; return s ? this.blobs.get(s).toString('utf8') : null; }
  log() { const out = []; for (let c = this.head; c; c = this.commits.get(c).parents[0]) out.push(this.commits.get(c).message); return out; }

  handle(method, url, headers, body) {
    this.calls.push(method + ' ' + url.pathname);
    const auth = headers.authorization || headers.Authorization;
    if (auth !== 'Bearer ' + this.token) return [401, { message: 'Bad credentials' }];
    const base = '/repos/' + this.repo;
    if (!url.pathname.startsWith(base + '/')) return [404, { message: 'Not Found' }];
    const p = decodeURIComponent(url.pathname.slice(base.length));
    let m;
    if (method === 'GET' && (m = /^\/contents\/(.+)$/.exec(p))) {
      const ref = url.searchParams.get('ref') || this.branch;
      const commit = this.commits.has(ref) ? ref : ref === this.branch ? this.head : null;
      if (!commit) return [404, { message: 'No commit found for the ref' }];
      const s = this._flat(this.commits.get(commit).tree)[m[1]];
      if (!s) return [404, { message: 'Not Found' }];
      const buf = this.blobs.get(s);
      return [200, { type: 'file', path: m[1], sha: s, size: buf.length, encoding: 'base64', content: buf.toString('base64').replace(/(.{60})/g, '$1\n') }];
    }
    if (method === 'GET' && p === '/git/ref/heads/' + this.branch) return [200, { ref: 'refs/heads/' + this.branch, object: { type: 'commit', sha: this.head } }];
    if (method === 'GET' && (m = /^\/git\/ref\/heads\/(.+)$/.exec(p))) return [404, { message: 'Not Found' }];
    if (method === 'GET' && (m = /^\/git\/commits\/(\w+)$/.exec(p))) { const c = this.commits.get(m[1]); return c ? [200, { sha: m[1], tree: { sha: c.tree } }] : [404, {}]; }
    if (method === 'GET' && (m = /^\/git\/trees\/(\w+)$/.exec(p))) { const t = this.trees.get(m[1]); return t ? [200, { sha: m[1], tree: t, truncated: false }] : [404, {}]; }
    if (method === 'GET' && (m = /^\/git\/blobs\/(\w+)$/.exec(p))) { const b = this.blobs.get(m[1]); return b ? [200, { sha: m[1], encoding: 'base64', content: b.toString('base64') }] : [404, {}]; }
    if (method === 'POST' || method === 'PATCH') {
      if (this.readOnly) return [403, { message: 'Resource not accessible by personal access token' }];
      if (method === 'POST' && p === '/git/blobs') { const b = Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8'); const s = blobSha(b); this.blobs.set(s, b); return [201, { sha: s }]; }
      if (method === 'POST' && p === '/git/trees') {
        const flat = body.base_tree ? this._flat(body.base_tree) : {};
        for (const e of body.tree) flat[e.path] = e.sha;
        return [201, { sha: this._tree(flat) }];
      }
      if (method === 'POST' && p === '/git/commits') { const s = this._commit(body.tree, body.parents, body.message); return [201, { sha: s, html_url: 'https://github.com/' + this.repo + '/commit/' + s }]; }
      if (method === 'PATCH' && p === '/git/refs/heads/' + this.branch) {
        if (this.raceOnce) { const f = this.raceOnce; this.raceOnce = null; f(); }
        const c = this.commits.get(body.sha);
        if (!c) return [422, { message: 'Object does not exist' }];
        if (c.parents[0] !== this.head && !body.force) return [422, { message: 'Update is not a fast forward' }];
        this.head = body.sha;
        return [200, { object: { sha: body.sha } }];
      }
    }
    return [404, { message: 'Not Found' }];
  }
  /** Drop-in for fetch(): answers api.github.com, refuses anything else. */
  get fetch() {
    return async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.hostname !== 'api.github.com') throw new Error('unexpected request to ' + url.hostname);
      const [status, json] = this.handle(init.method || 'GET', url, init.headers || {}, init.body ? JSON.parse(init.body) : null);
      return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
    };
  }
  /** The same thing over HTTP, for a panel started as its own process (GITHUB_API_URL). */
  listen() {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const [status, json] = this.handle(req.method, new URL(req.url, 'http://x'), req.headers, raw ? JSON.parse(raw) : null);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      });
    });
    return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, url: 'http://127.0.0.1:' + server.address().port })));
  }
}
