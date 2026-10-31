import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';

let app;
let base;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'misyve-'));

before(async () => {
  app = await createApp({ dataDir: tmp, adminEmail: 'admin@test.mg', adminPassword: 'MotDePasse-Admin1', quiet: true, isProd: false });
  base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
});
after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Petit client HTTP avec gestion des cookies. */
function client() {
  let cookie = '';
  const call = async (method, url, body, extra = {}) => {
    const headers = { 'X-Requested-With': 'misyve', ...extra };
    let payload;
    if (Buffer.isBuffer(body)) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: payload });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) {
      const pair = c.split(';')[0];
      cookie = pair.endsWith('=') ? '' : pair;
    }
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b, h) => call('PUT', u, b, h),
    patch: (u, b) => call('PATCH', u, b), del: (u) => call('DELETE', u), call,
  };
}

const shopForm = (n) => ({
  shop: `Boutique ${n}`, owner: `Responsable ${n}`, email: `vendeur${n}@test.mg`, password: 'secret-123',
  city: 'Mahajanga', category: 'Informatique', phone: '034 12 345 67', address: 'Centre-ville', description: 'Test',
});

test('santé du serveur et en-têtes de sécurité', async () => {
  const c = client();
  const r = await c.get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('catalogue : données d’exemple, recherche sans accents, filtres, tri, pagination', async () => {
  const c = client();
  const all = (await c.get('/api/products?limit=48')).data;
  assert.equal(all.total, 8);
  const s = (await c.get('/api/products?q=ecouteurs')).data;
  assert.equal(s.total, 1);
  assert.equal(s.items[0].name, 'Écouteurs Bluetooth');
  assert.equal((await c.get('/api/products?city=Mahajanga')).data.total, 4);
  assert.equal((await c.get('/api/products?category=Mode')).data.total, 2);
  const asc = (await c.get('/api/products?sort=price-asc&limit=48')).data.items.map((p) => p.price);
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
  const p1 = (await c.get('/api/products?limit=3&page=1')).data;
  assert.equal(p1.items.length, 3);
  assert.equal(p1.pages, 3);
  assert.equal((await c.get('/api/products?q=%25')).data.total, 0, 'le % est traité comme du texte');
  const meta = (await c.get('/api/meta')).data;
  assert.ok(meta.cities.includes('Mahajanga'));
  assert.equal(meta.stats.products, 8);
});

test('protection CSRF : les requêtes modifiantes exigent l’en-tête', async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.mg', password: 'x' }),
  });
  assert.equal(res.status, 403);
});

test('accès protégés : 401 sans connexion, 403 avec le mauvais rôle', async () => {
  const c = client();
  assert.equal((await c.get('/api/admin/overview')).status, 401);
  assert.equal((await c.get('/api/seller/overview')).status, 401);
  await c.post('/api/auth/register', shopForm('roles'));
  assert.equal((await c.get('/api/admin/overview')).status, 403);
});

test('parcours complet : inscription, validation admin, publication, photo, signalement', async () => {
  const seller = client();
  const reg = await seller.post('/api/auth/register', shopForm(1));
  assert.equal(reg.status, 201);
  assert.equal(reg.data.shop.status, 'pending');
  assert.equal((await seller.post('/api/auth/register', shopForm(1))).status, 409, 'e-mail déjà utilisé');

  const created = await seller.post('/api/seller/products', { name: 'Imprimante laser', category: 'Informatique', price: '450 000', description: 'Neuve' });
  assert.equal(created.status, 201);
  const pid = created.data.id;
  assert.equal(created.data.price, 450000);
  assert.equal((await client().get('/api/products?q=imprimante')).data.total, 0, 'invisible tant que la boutique n’est pas validée');
  assert.equal((await client().get(`/api/products/${pid}`)).status, 404);

  const admin = client();
  assert.equal((await admin.post('/api/auth/login', { email: 'admin@test.mg', password: 'mauvais' })).status, 401);
  const login = await admin.post('/api/auth/login', { email: 'admin@test.mg', password: 'MotDePasse-Admin1' });
  assert.equal(login.data.user.role, 'admin');
  const pending = (await admin.get('/api/admin/shops?status=pending')).data.items;
  const shop = pending.find((s) => s.email === 'vendeur1@test.mg');
  assert.ok(shop);
  assert.equal((await admin.patch(`/api/admin/shops/${shop.id}`, { status: 'approved' })).status, 200);

  const visible = (await client().get('/api/products?q=IMPRIMANTE')).data;
  assert.equal(visible.total, 1);
  assert.equal(visible.items[0].shop.name, 'Boutique 1');

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const up = await seller.put(`/api/seller/products/${pid}/image`, png, { 'Content-Type': 'image/png' });
  assert.equal(up.status, 200);
  assert.match(up.data.image, /^\/uploads\/[a-f0-9]{32}\.png$/);
  const img = await fetch(base + up.data.image);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  const fake = await seller.put(`/api/seller/products/${pid}/image`, Buffer.from('<script>alert(1)</script>'.repeat(5)), { 'Content-Type': 'image/png' });
  assert.equal(fake.status, 400, 'un faux fichier image est refusé');

  const pub = client();
  await pub.get(`/api/products/${pid}`);
  await pub.post(`/api/products/${pid}/contact`);
  assert.equal((await pub.post(`/api/products/${pid}/report`, { reason: 'Prix incorrect', details: 'Trop bas' })).status, 201);
  assert.equal((await pub.post(`/api/products/${pid}/report`, { reason: 'Inventé' })).status, 400);
  const ov = (await seller.get('/api/seller/overview')).data;
  assert.equal(ov.totals.views, 1);
  assert.equal(ov.totals.contacts, 1);

  const reports = (await admin.get('/api/admin/reports')).data.items;
  assert.equal(reports.length, 1);
  assert.equal((await admin.patch(`/api/admin/reports/${reports[0].id}`, { status: 'resolved' })).status, 200);
  assert.equal((await admin.patch(`/api/admin/products/${pid}`, { status: 'hidden' })).status, 200);
  assert.equal((await client().get(`/api/products/${pid}`)).status, 404, 'produit masqué');

  const del = await seller.del(`/api/seller/products/${pid}`);
  assert.equal(del.status, 204);
  assert.equal((await fetch(base + up.data.image)).status, 404, 'la photo est supprimée avec le produit');
});

test('isolation : un vendeur ne peut pas modifier le produit d’un autre', async () => {
  const a = client();
  const b = client();
  await a.post('/api/auth/register', shopForm('A'));
  await b.post('/api/auth/register', shopForm('B'));
  const p = (await a.post('/api/seller/products', { name: 'Produit A', category: 'Mode', price: 1000 })).data;
  assert.equal((await b.put(`/api/seller/products/${p.id}`, { name: 'Piraté', category: 'Mode', price: 1 })).status, 404);
  assert.equal((await b.del(`/api/seller/products/${p.id}`)).status, 404);
  assert.equal((await a.put(`/api/seller/products/${p.id}`, { name: 'Produit A2', category: 'Mode', price: 2000 })).data.price, 2000);
});

test('validation des entrées', async () => {
  const c = client();
  assert.equal((await c.post('/api/auth/register', { ...shopForm('v1'), email: 'pas-un-email' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { ...shopForm('v2'), password: 'court' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { ...shopForm('v3'), phone: 'abc' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { ...shopForm('v4'), city: 'Paris' })).status, 400);
  await c.post('/api/auth/register', shopForm('v5'));
  assert.equal((await c.post('/api/seller/products', { name: 'X', category: 'Mode', price: -5 })).status, 400);
  assert.equal((await c.post('/api/seller/products', { name: 'Valide', category: 'Inconnue', price: 5 })).status, 400);
  const raw = await c.call('POST', '/api/auth/login', undefined, { 'Content-Type': 'application/json' });
  assert.equal(raw.status, 400);
});

test('changement de mot de passe et déconnexion', async () => {
  const c = client();
  await c.post('/api/auth/register', shopForm('pw'));
  assert.equal((await c.post('/api/auth/password', { current: 'faux-faux', next: 'nouveau-mdp-1' })).status, 400);
  assert.equal((await c.post('/api/auth/password', { current: 'secret-123', next: 'nouveau-mdp-1' })).status, 200);
  assert.equal((await c.post('/api/auth/logout')).status, 204);
  assert.equal((await c.get('/api/auth/me')).data.user, null);
  assert.equal((await c.post('/api/auth/login', { email: 'vendeurpw@test.mg', password: 'secret-123' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { email: 'vendeurpw@test.mg', password: 'nouveau-mdp-1' })).status, 200);
});

test('limitation des tentatives de connexion', async () => {
  const c = client();
  let last;
  for (let i = 0; i < 10; i++) last = await c.post('/api/auth/login', { email: 'cible@test.mg', password: 'faux-mdp-123' });
  assert.equal(last.status, 429);
});

test('fichiers statiques : pas de traversée de dossier, page 404', async () => {
  for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/server.js', '/uploads/..%2f..%2fmisyve.sqlite', '/data/misyve.sqlite']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 404, p);
  }
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /MISY/);
});

test('l’admin peut supprimer les données d’exemple', async () => {
  const admin = client();
  await admin.post('/api/auth/login', { email: 'admin@test.mg', password: 'MotDePasse-Admin1' });
  const r = await admin.del('/api/admin/demo');
  assert.equal(r.data.removed, 6);
  assert.equal((await client().get('/api/products')).data.items.every((p) => !p.shop.name.includes('Tech Mada')), true);
});
