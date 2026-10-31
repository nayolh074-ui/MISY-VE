import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './src/config.js';
import { openDb, ensureAdmin, seedDemo } from './src/db.js';
import { buildRoutes } from './src/routes.js';
import { findSessionUser, parseCookies, sessionCookie, clearCookie, COOKIE_NAME } from './src/auth.js';
import { HttpError, RateLimiter } from './src/util.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt', '.webmanifest']);

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com", "style-src-attr 'unsafe-inline'",
  "font-src https://fonts.gstatic.com", "img-src 'self' data: blob:", "connect-src 'self'", "object-src 'none'",
  "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

function compile(routes) {
  return routes.map((rt) => {
    const names = [];
    const re = new RegExp('^' + rt.pattern.replace(/:([a-z]+)/g, (_, n) => (names.push(n), '([^/]+)')) + '/?$');
    return { ...rt, re, names };
  });
}

export async function createApp(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const log = config.quiet ? { log() {}, error() {} } : console;
  const db = openDb(config);
  await ensureAdmin(db, config, log);
  if (config.seedDemo) seedDemo(db);

  const limiter = new RateLimiter();
  const routes = compile(buildRoutes({ db, config, limiter }));
  const uploadsDir = path.join(config.dataDir, 'uploads');
  const gzipCache = new Map();

  const clientIp = (req) => {
    if (config.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
  };

  function securityHeaders(res) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.isProd) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }

  function sendJson(res, status, data) {
    if (status === 204 || data === undefined) {
      res.writeHead(status === 200 ? 204 : status);
      return res.end();
    }
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  async function readBody(req, max) {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > max) throw new HttpError(413, 'La requête ou le fichier est trop volumineux.');
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > max) throw new HttpError(413, 'La requête ou le fichier est trop volumineux.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function handleApi(req, res, url, ip) {
    res.setHeader('Cache-Control', 'no-store');
    const method = req.method;
    let pathMatched = false;
    let route = null;
    let params = {};
    for (const rt of routes) {
      const m = rt.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (rt.method === method) {
        route = rt;
        rt.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
        break;
      }
    }
    if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Méthode non autorisée.' : 'Route introuvable.');

    const mutating = method !== 'GET' && method !== 'HEAD';
    if (mutating && req.headers['x-requested-with'] !== 'misyve') throw new HttpError(403, 'Requête refusée.');
    limiter.check(`api:${ip}`, 300, 60_000);

    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const user = findSessionUser(db, token);
    if (route.auth) {
      if (!user) throw new HttpError(401, 'Connecte-toi pour continuer.');
      if (route.auth !== 'user' && user.role !== route.auth) throw new HttpError(403, 'Accès non autorisé.');
    }
    if (route.limit) limiter.check(`${route.limit[0]}:${ip}`, route.limit[1], route.limit[2]);

    const secure = config.isProd;
    const ctx = {
      req, res, params, ip, user, token, query: url.searchParams, body: {}, rawBody: null, status: undefined,
      startSession(t) { res.setHeader('Set-Cookie', sessionCookie(t, { days: config.sessionDays, secure })); ctx.token = t; },
      endSession() { res.setHeader('Set-Cookie', clearCookie({ secure })); },
    };

    if (mutating) {
      const ctype = String(req.headers['content-type'] || '').toLowerCase();
      if (route.raw) {
        if (!ctype.startsWith('image/')) throw new HttpError(415, 'Type de fichier non supporté.');
        ctx.rawBody = await readBody(req, route.raw);
      } else {
        const buf = await readBody(req, 64 * 1024);
        if (buf.length) {
          if (!ctype.includes('application/json')) throw new HttpError(415, 'Type de contenu non supporté.');
          try { ctx.body = JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'Requête invalide (JSON).'); }
          if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw new HttpError(400, 'Requête invalide.');
        }
      }
    }

    const result = await route.handler(ctx);
    sendJson(res, ctx.status ?? (result === undefined ? 204 : 200), result);
  }

  async function serveFile(req, res, file, { immutable = false } = {}) {
    const st = await fsp.stat(file).catch(() => null);
    if (!st || !st.isFile()) throw new HttpError(404, 'Introuvable.');
    const ext = path.extname(file).toLowerCase();
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ETag: etag,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=86400',
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    const wantsGzip = COMPRESSIBLE.has(ext) && st.size > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (wantsGzip) {
      let c = gzipCache.get(file);
      if (!c || c.etag !== etag) {
        c = { etag, buf: zlib.gzipSync(await fsp.readFile(file)) };
        gzipCache.set(file, c);
      }
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': c.buf.length });
      return res.end(req.method === 'HEAD' ? undefined : c.buf);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  async function handleStatic(req, res, url) {
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'URL invalide.'); }
    if (pathname.includes('\0')) throw new HttpError(400, 'URL invalide.');

    if (pathname.startsWith('/uploads/')) {
      const name = pathname.slice('/uploads/'.length);
      if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(name)) throw new HttpError(404, 'Introuvable.');
      return serveFile(req, res, path.join(uploadsDir, name), { immutable: true });
    }

    if (pathname === '/') pathname = '/index.html';
    const candidates = [pathname];
    if (!path.extname(pathname)) candidates.push(`${pathname}.html`);
    for (const c of candidates) {
      const file = path.join(config.publicDir, path.normalize(c));
      if (!file.startsWith(config.publicDir + path.sep)) throw new HttpError(404, 'Introuvable.');
      try { return await serveFile(req, res, file); } catch (e) { if (e instanceof HttpError) throw e; }
    }
    throw new HttpError(404, 'Introuvable.');
  }

  async function notFoundPage(req, res) {
    try {
      const html = await fsp.readFile(path.join(config.publicDir, '404.html'));
      res.writeHead(404, { 'Content-Type': MIME['.html'], 'Content-Length': html.length });
      res.end(req.method === 'HEAD' ? undefined : html);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Page introuvable');
    }
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
    const ip = clientIp(req);
    const isApi = url.pathname.startsWith('/api/');
    securityHeaders(res);
    if (isApi) res.on('finish', () => log.log(`${new Date().toISOString()} ${ip} ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`));
    try {
      if (isApi) return await handleApi(req, res, url, ip);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Méthode non autorisée.');
      await handleStatic(req, res, url);
    } catch (e) {
      if (res.headersSent) return res.end();
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) log.error(e);
      if (!isApi && status === 404) return notFoundPage(req, res);
      if (status === 413 || (isApi && !req.complete)) res.setHeader('Connection', 'close');
      sendJson(res, status, { error: e instanceof HttpError ? e.message : 'Erreur interne du serveur.' });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 65_000;

  const purge = setInterval(() => {
    try { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString()); } catch { /* base fermée */ }
  }, 3_600_000);
  purge.unref();

  return {
    server, db, config,
    listen: (port = config.port, host = '0.0.0.0') => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => {
      clearInterval(purge);
      limiter.close();
      server.close(() => { try { db.close(); } catch { /* déjà fermée */ } resolve(); });
      server.closeAllConnections?.();
    }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  const port = await app.listen();
  console.log(`MISY VE ? en ligne sur http://localhost:${port}  (données : ${app.config.dataDir})`);
  const stop = async () => { console.log('Arrêt en cours…'); await app.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
