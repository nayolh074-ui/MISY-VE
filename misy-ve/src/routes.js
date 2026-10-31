import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CITIES, CATEGORIES } from './config.js';
import { tx, categoryStyle, searchText, reindexShopProducts } from './db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, destroyOtherSessions,
} from './auth.js';
import {
  HttpError, cleanText, cleanEmail, cleanPhone, cleanEnum, cleanPrice, cleanPassword,
  toId, escapeLike, normalize, sniffImage,
} from './util.js';

const CITY_NAMES = CITIES;
const CAT_NAMES = CATEGORIES.map((c) => c.name);
const REPORT_REASONS = ['Prix incorrect', 'Produit indisponible', 'Contact invalide', 'Contenu inapproprié', 'Autre'];
const SHOP_STATUSES = ['pending', 'approved', 'rejected', 'suspended'];
const MAX_PRODUCTS_PER_SHOP = 200;

const PRODUCT_SELECT = `
  SELECT p.id, p.name, p.category, p.price, p.description, p.emoji, p.color, p.image, p.status,
         p.views, p.contacts, p.created_at, p.updated_at, p.shop_id,
         s.name AS shop_name, s.city AS shop_city, s.address AS shop_address,
         s.phone AS shop_phone, s.status AS shop_status
  FROM products p JOIN shops s ON s.id = p.shop_id`;

const imgUrl = (f) => (f ? `/uploads/${f}` : null);

function publicProduct(r) {
  return {
    id: r.id, name: r.name, category: r.category, price: r.price, description: r.description,
    emoji: r.emoji, color: r.color, image: imgUrl(r.image), createdAt: r.created_at, updatedAt: r.updated_at,
    shop: { id: r.shop_id, name: r.shop_name, city: r.shop_city, address: r.shop_address, phone: r.shop_phone },
  };
}
const ownerProduct = (r) => ({ ...publicProduct(r), status: r.status, shopStatus: r.shop_status, views: r.views, contacts: r.contacts });

const shopOut = (s) => s && ({
  id: s.id, name: s.name, owner: s.owner, city: s.city, category: s.category, phone: s.phone,
  address: s.address, description: s.description, status: s.status, createdAt: s.created_at,
});
const userOut = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

const clampInt = (v, min, max, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

export function buildRoutes({ db, config, limiter }) {
  const routes = [];
  const r = (method, pattern, opts, handler) => routes.push({ method, pattern, ...opts, handler });
  const now = () => new Date().toISOString();
  const seen = new Map();
  const dedupe = (key, windowMs) => {
    const t = Date.now();
    if (seen.size > 50_000) seen.clear();
    if ((seen.get(key) || 0) > t - windowMs) return false;
    seen.set(key, t);
    return true;
  };
  let dummyHash;

  const shopOfUser = (userId) => db.prepare('SELECT * FROM shops WHERE user_id = ?').get(userId);
  const requireShop = (user) => {
    const s = shopOfUser(user.id);
    if (!s) throw new HttpError(404, 'Aucune boutique n’est liée à ce compte.');
    return s;
  };
  const ownedProduct = (id, shopId) => {
    const p = db.prepare('SELECT * FROM products WHERE id = ? AND shop_id = ?').get(toId(id), shopId);
    if (!p) throw new HttpError(404, 'Produit introuvable.');
    return p;
  };
  const productFull = (id) => db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(id);
  const removeImageFile = async (name) => {
    if (name && /^[a-f0-9]{32}\.(jpg|png|webp)$/.test(name)) {
      await fs.unlink(path.join(config.dataDir, 'uploads', name)).catch(() => {});
    }
  };
  const count = (sql, ...a) => db.prepare(sql).get(...a).n;

  /* ───────────── Public ───────────── */

  r('GET', '/api/health', {}, () => ({ ok: true, time: now() }));

  r('GET', '/api/meta', {}, () => ({
    cities: CITY_NAMES,
    categories: CATEGORIES.map(({ name, emoji }) => ({ name, emoji })),
    stats: {
      products: count(`SELECT COUNT(*) AS n FROM products p JOIN shops s ON s.id = p.shop_id WHERE p.status='approved' AND s.status='approved'`),
      shops: count(`SELECT COUNT(*) AS n FROM shops WHERE status='approved'`),
    },
  }));

  r('GET', '/api/products', {}, ({ query }) => {
    const where = ["p.status = 'approved'", "s.status = 'approved'"];
    const args = [];
    const q = normalize(query.get('q') || '').slice(0, 80);
    for (const tok of q.split(/\s+/).filter(Boolean).slice(0, 5)) {
      where.push("p.search LIKE ? ESCAPE '\\'");
      args.push(`%${escapeLike(tok)}%`);
    }
    const city = query.get('city');
    if (city && city !== 'Toutes les villes') { where.push('s.city = ?'); args.push(city); }
    const category = query.get('category');
    if (category && category !== 'Tout') { where.push('p.category = ?'); args.push(category); }
    const order = { 'price-asc': 'p.price ASC, p.id DESC', 'price-desc': 'p.price DESC, p.id DESC' }[query.get('sort')] || 'p.created_at DESC, p.id DESC';
    const limit = clampInt(query.get('limit'), 1, 48, 12);
    const page = clampInt(query.get('page'), 1, 10_000, 1);
    const clause = where.join(' AND ');
    const total = count(`SELECT COUNT(*) AS n FROM products p JOIN shops s ON s.id = p.shop_id WHERE ${clause}`, ...args);
    const items = db.prepare(`${PRODUCT_SELECT} WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...args, limit, (page - 1) * limit).map(publicProduct);
    return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
  });

  const visibleProduct = (id) => {
    const row = productFull(toId(id));
    if (!row || row.status !== 'approved' || row.shop_status !== 'approved') throw new HttpError(404, 'Ce produit n’est plus disponible.');
    return row;
  };

  r('GET', '/api/products/:id', {}, (ctx) => {
    const row = visibleProduct(ctx.params.id);
    if (dedupe(`view:${ctx.ip}:${row.id}`, 3_600_000)) {
      db.prepare('UPDATE products SET views = views + 1 WHERE id = ?').run(row.id);
    }
    return publicProduct(row);
  });

  r('POST', '/api/products/:id/contact', {}, (ctx) => {
    const row = visibleProduct(ctx.params.id);
    if (dedupe(`contact:${ctx.ip}:${row.id}`, 600_000)) {
      db.prepare('UPDATE products SET contacts = contacts + 1 WHERE id = ?').run(row.id);
    }
    ctx.status = 204;
  });

  r('POST', '/api/products/:id/report', { limit: ['report', 5, 3_600_000] }, (ctx) => {
    const row = visibleProduct(ctx.params.id);
    const reason = cleanEnum(ctx.body.reason, REPORT_REASONS, 'Le motif');
    const details = cleanText(ctx.body.details, { field: 'Le détail', max: 300, multiline: true });
    db.prepare('INSERT INTO reports (product_id, reason, details, created_at) VALUES (?,?,?,?)').run(row.id, reason, details, now());
    ctx.status = 201;
    return { ok: true };
  });

  /* ───────────── Authentification ───────────── */

  r('POST', '/api/auth/register', { limit: ['register', 20, 3_600_000] }, async (ctx) => {
    const b = ctx.body;
    const shop = cleanText(b.shop, { field: 'Le nom de la boutique', required: true, min: 2, max: 80 });
    const owner = cleanText(b.owner, { field: 'Le nom du responsable', required: true, min: 2, max: 80 });
    const email = cleanEmail(b.email);
    const password = cleanPassword(b.password);
    const city = cleanEnum(b.city, CITY_NAMES, 'La ville');
    const category = cleanEnum(b.category, CAT_NAMES, 'La catégorie');
    const phone = cleanPhone(b.phone);
    const address = cleanText(b.address, { field: 'L’adresse', max: 150 });
    const description = cleanText(b.description, { field: 'La description', max: 500, multiline: true });
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'Un compte existe déjà avec cet e-mail. Connecte-toi plutôt.');
    }
    const hash = await hashPassword(password);
    let userId;
    try {
      userId = tx(db, () => {
        const t = now();
        const u = db.prepare('INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?,?,?,?,?)')
          .run(email, owner, hash, 'seller', t);
        const id = Number(u.lastInsertRowid);
        db.prepare(`INSERT INTO shops (user_id, name, owner, city, category, phone, address, description, status, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?)`).run(id, shop, owner, city, category, phone, address, description, t, t);
        return id;
      });
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'Un compte existe déjà avec cet e-mail. Connecte-toi plutôt.');
      throw e;
    }
    ctx.startSession(createSession(db, userId, config.sessionDays));
    ctx.status = 201;
    return { user: userOut({ id: userId, name: owner, email, role: 'seller' }), shop: shopOut(shopOfUser(userId)) };
  });

  r('POST', '/api/auth/login', {}, async (ctx) => {
    const email = cleanEmail(ctx.body.email);
    const password = typeof ctx.body.password === 'string' ? ctx.body.password.slice(0, 200) : '';
    limiter.check(`login-ip:${ctx.ip}`, 20, 15 * 60_000);
    limiter.check(`login-mail:${email}`, 8, 15 * 60_000);
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    dummyHash ??= await hashPassword('mot-de-passe-factice');
    const ok = await verifyPassword(password, u ? u.password_hash : dummyHash);
    if (!u || !ok) throw new HttpError(401, 'E-mail ou mot de passe incorrect.');
    ctx.startSession(createSession(db, u.id, config.sessionDays));
    return { user: userOut(u), shop: u.role === 'seller' ? shopOut(shopOfUser(u.id)) : null };
  });

  r('POST', '/api/auth/logout', {}, (ctx) => {
    destroySession(db, ctx.token);
    ctx.endSession();
    ctx.status = 204;
  });

  r('GET', '/api/auth/me', {}, (ctx) => {
    if (!ctx.user) return { user: null, shop: null };
    return { user: userOut(ctx.user), shop: ctx.user.role === 'seller' ? shopOut(shopOfUser(ctx.user.id)) : null };
  });

  r('POST', '/api/auth/password', { auth: 'user', limit: ['password', 10, 3_600_000] }, async (ctx) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
    const current = typeof ctx.body.current === 'string' ? ctx.body.current : '';
    if (!(await verifyPassword(current, u.password_hash))) throw new HttpError(400, 'Le mot de passe actuel est incorrect.');
    const next = cleanPassword(ctx.body.next, 'Le nouveau mot de passe');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), u.id);
    destroyOtherSessions(db, u.id, ctx.token);
    return { ok: true };
  });

  /* ───────────── Espace vendeur ───────────── */

  r('GET', '/api/seller/overview', { auth: 'seller' }, (ctx) => {
    const shop = requireShop(ctx.user);
    const products = db.prepare(`${PRODUCT_SELECT} WHERE p.shop_id = ? ORDER BY p.created_at DESC, p.id DESC`).all(shop.id).map(ownerProduct);
    return {
      shop: shopOut(shop),
      products,
      totals: {
        products: products.length,
        views: products.reduce((a, p) => a + p.views, 0),
        contacts: products.reduce((a, p) => a + p.contacts, 0),
      },
    };
  });

  r('PUT', '/api/seller/shop', { auth: 'seller' }, (ctx) => {
    const shop = requireShop(ctx.user);
    const b = ctx.body;
    const name = cleanText(b.name, { field: 'Le nom de la boutique', required: true, min: 2, max: 80 });
    const owner = cleanText(b.owner, { field: 'Le nom du responsable', required: true, min: 2, max: 80 });
    const city = cleanEnum(b.city, CITY_NAMES, 'La ville');
    const category = cleanEnum(b.category, CAT_NAMES, 'La catégorie');
    const phone = cleanPhone(b.phone);
    const address = cleanText(b.address, { field: 'L’adresse', max: 150 });
    const description = cleanText(b.description, { field: 'La description', max: 500, multiline: true });
    const status = shop.status === 'rejected' ? 'pending' : shop.status;
    tx(db, () => {
      db.prepare(`UPDATE shops SET name=?, owner=?, city=?, category=?, phone=?, address=?, description=?, status=?, updated_at=? WHERE id=?`)
        .run(name, owner, city, category, phone, address, description, status, now(), shop.id);
      reindexShopProducts(db, shop.id);
    });
    return { shop: shopOut(shopOfUser(ctx.user.id)) };
  });

  const readProductFields = (b) => {
    const name = cleanText(b.name, { field: 'Le nom du produit', required: true, min: 2, max: 100 });
    const category = cleanEnum(b.category, CAT_NAMES, 'La catégorie');
    const price = cleanPrice(b.price);
    const description = cleanText(b.description, { field: 'La description', max: 600, multiline: true });
    return { name, category, price, description };
  };

  r('POST', '/api/seller/products', { auth: 'seller' }, (ctx) => {
    const shop = requireShop(ctx.user);
    if (count('SELECT COUNT(*) AS n FROM products WHERE shop_id = ?', shop.id) >= MAX_PRODUCTS_PER_SHOP) {
      throw new HttpError(400, `Limite atteinte : ${MAX_PRODUCTS_PER_SHOP} produits par boutique.`);
    }
    const f = readProductFields(ctx.body);
    const style = categoryStyle(f.category);
    const t = now();
    const res = db.prepare(`INSERT INTO products (shop_id, name, category, price, description, emoji, color, search, created_at, updated_at)
                            VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(shop.id, f.name, f.category, f.price, f.description, style.emoji, style.color,
        searchText([f.name, f.category, f.description, shop.name, shop.city]), t, t);
    ctx.status = 201;
    return ownerProduct(productFull(Number(res.lastInsertRowid)));
  });

  r('PUT', '/api/seller/products/:id', { auth: 'seller' }, (ctx) => {
    const shop = requireShop(ctx.user);
    const p = ownedProduct(ctx.params.id, shop.id);
    const f = readProductFields(ctx.body);
    const style = categoryStyle(f.category);
    db.prepare(`UPDATE products SET name=?, category=?, price=?, description=?, emoji=?, color=?, search=?, updated_at=? WHERE id=?`)
      .run(f.name, f.category, f.price, f.description, style.emoji, style.color,
        searchText([f.name, f.category, f.description, shop.name, shop.city]), now(), p.id);
    return ownerProduct(productFull(p.id));
  });

  r('POST', '/api/seller/products/:id/touch', { auth: 'seller' }, (ctx) => {
    const shop = requireShop(ctx.user);
    const p = ownedProduct(ctx.params.id, shop.id);
    db.prepare('UPDATE products SET updated_at = ? WHERE id = ?').run(now(), p.id);
    return ownerProduct(productFull(p.id));
  });

  r('DELETE', '/api/seller/products/:id', { auth: 'seller' }, async (ctx) => {
    const shop = requireShop(ctx.user);
    const p = ownedProduct(ctx.params.id, shop.id);
    db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
    await removeImageFile(p.image);
    ctx.status = 204;
  });

  r('PUT', '/api/seller/products/:id/image', { auth: 'seller', raw: config.maxImageBytes, limit: ['upload', 60, 3_600_000] }, async (ctx) => {
    const shop = requireShop(ctx.user);
    const p = ownedProduct(ctx.params.id, shop.id);
    const buf = ctx.rawBody;
    if (!buf || !buf.length) throw new HttpError(400, 'Aucune image reçue.');
    const ext = sniffImage(buf);
    if (!ext) throw new HttpError(400, 'Format non supporté : utilise une image JPG, PNG ou WebP.');
    const file = `${randomBytes(16).toString('hex')}.${ext}`;
    await fs.writeFile(path.join(config.dataDir, 'uploads', file), buf, { flag: 'wx' });
    db.prepare('UPDATE products SET image = ?, updated_at = ? WHERE id = ?').run(file, now(), p.id);
    await removeImageFile(p.image);
    return ownerProduct(productFull(p.id));
  });

  r('DELETE', '/api/seller/products/:id/image', { auth: 'seller' }, async (ctx) => {
    const shop = requireShop(ctx.user);
    const p = ownedProduct(ctx.params.id, shop.id);
    db.prepare('UPDATE products SET image = NULL, updated_at = ? WHERE id = ?').run(now(), p.id);
    await removeImageFile(p.image);
    return ownerProduct(productFull(p.id));
  });

  /* ───────────── Administration ───────────── */

  r('GET', '/api/admin/overview', { auth: 'admin' }, () => ({
    shops: Object.fromEntries(SHOP_STATUSES.map((s) => [s, count('SELECT COUNT(*) AS n FROM shops WHERE status = ?', s)])),
    products: {
      total: count('SELECT COUNT(*) AS n FROM products'),
      visible: count(`SELECT COUNT(*) AS n FROM products p JOIN shops s ON s.id = p.shop_id WHERE p.status='approved' AND s.status='approved'`),
    },
    openReports: count(`SELECT COUNT(*) AS n FROM reports WHERE status = 'open'`),
    sellers: count(`SELECT COUNT(*) AS n FROM users WHERE role = 'seller'`),
    views: count('SELECT COALESCE(SUM(views),0) AS n FROM products'),
    contacts: count('SELECT COALESCE(SUM(contacts),0) AS n FROM products'),
    demoShops: count('SELECT COUNT(*) AS n FROM shops WHERE demo = 1'),
  }));

  r('GET', '/api/admin/shops', { auth: 'admin' }, ({ query }) => {
    const status = query.get('status');
    const where = SHOP_STATUSES.includes(status) ? 'WHERE s.status = ?' : '';
    const rows = db.prepare(`
      SELECT s.*, u.email, (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id) AS products_count
      FROM shops s LEFT JOIN users u ON u.id = s.user_id ${where}
      ORDER BY CASE s.status WHEN 'pending' THEN 0 ELSE 1 END, s.created_at DESC LIMIT 500`)
      .all(...(where ? [status] : []));
    return { items: rows.map((s) => ({ ...shopOut(s), email: s.email, productsCount: s.products_count, demo: !!s.demo })) };
  });

  r('PATCH', '/api/admin/shops/:id', { auth: 'admin' }, (ctx) => {
    const id = toId(ctx.params.id);
    const status = cleanEnum(ctx.body.status, SHOP_STATUSES, 'Le statut');
    const res = db.prepare('UPDATE shops SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
    if (!res.changes) throw new HttpError(404, 'Boutique introuvable.');
    return { ok: true };
  });

  const deleteShop = async (id) => {
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(id);
    if (!shop) throw new HttpError(404, 'Boutique introuvable.');
    const images = db.prepare('SELECT image FROM products WHERE shop_id = ? AND image IS NOT NULL').all(id);
    if (shop.user_id) db.prepare(`DELETE FROM users WHERE id = ? AND role = 'seller'`).run(shop.user_id);
    db.prepare('DELETE FROM shops WHERE id = ?').run(id);
    await Promise.all(images.map((i) => removeImageFile(i.image)));
  };

  r('DELETE', '/api/admin/shops/:id', { auth: 'admin' }, async (ctx) => {
    await deleteShop(toId(ctx.params.id));
    ctx.status = 204;
  });

  r('GET', '/api/admin/products', { auth: 'admin' }, ({ query }) => {
    const where = [];
    const args = [];
    const q = normalize(query.get('q') || '').slice(0, 80);
    for (const tok of q.split(/\s+/).filter(Boolean).slice(0, 5)) {
      where.push("p.search LIKE ? ESCAPE '\\'");
      args.push(`%${escapeLike(tok)}%`);
    }
    if (['approved', 'hidden'].includes(query.get('status'))) { where.push('p.status = ?'); args.push(query.get('status')); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = clampInt(query.get('limit'), 1, 100, 50);
    const page = clampInt(query.get('page'), 1, 10_000, 1);
    const total = count(`SELECT COUNT(*) AS n FROM products p ${clause}`, ...args);
    const rows = db.prepare(`
      SELECT p.id, p.name, p.category, p.price, p.status, p.views, p.contacts, p.created_at, p.updated_at,
             s.id AS shop_id, s.name AS shop_name, s.status AS shop_status,
             (SELECT COUNT(*) FROM reports r WHERE r.product_id = p.id AND r.status = 'open') AS open_reports
      FROM products p JOIN shops s ON s.id = p.shop_id ${clause}
      ORDER BY open_reports DESC, p.created_at DESC LIMIT ? OFFSET ?`).all(...args, limit, (page - 1) * limit);
    return {
      total, page, pages: Math.max(1, Math.ceil(total / limit)),
      items: rows.map((p) => ({
        id: p.id, name: p.name, category: p.category, price: p.price, status: p.status, views: p.views,
        contacts: p.contacts, updatedAt: p.updated_at, openReports: p.open_reports,
        shop: { id: p.shop_id, name: p.shop_name, status: p.shop_status },
      })),
    };
  });

  r('PATCH', '/api/admin/products/:id', { auth: 'admin' }, (ctx) => {
    const status = cleanEnum(ctx.body.status, ['approved', 'hidden'], 'Le statut');
    const res = db.prepare('UPDATE products SET status = ? WHERE id = ?').run(status, toId(ctx.params.id));
    if (!res.changes) throw new HttpError(404, 'Produit introuvable.');
    return { ok: true };
  });

  r('DELETE', '/api/admin/products/:id', { auth: 'admin' }, async (ctx) => {
    const p = db.prepare('SELECT image FROM products WHERE id = ?').get(toId(ctx.params.id));
    if (!p) throw new HttpError(404, 'Produit introuvable.');
    db.prepare('DELETE FROM products WHERE id = ?').run(toId(ctx.params.id));
    await removeImageFile(p.image);
    ctx.status = 204;
  });

  r('GET', '/api/admin/reports', { auth: 'admin' }, () => ({
    items: db.prepare(`
      SELECT r.id, r.reason, r.details, r.status, r.created_at, p.id AS product_id, p.name AS product_name, s.name AS shop_name
      FROM reports r JOIN products p ON p.id = r.product_id JOIN shops s ON s.id = p.shop_id
      ORDER BY (r.status = 'open') DESC, r.created_at DESC LIMIT 200`).all().map((x) => ({
      id: x.id, reason: x.reason, details: x.details, status: x.status, createdAt: x.created_at,
      product: { id: x.product_id, name: x.product_name }, shopName: x.shop_name,
    })),
  }));

  r('PATCH', '/api/admin/reports/:id', { auth: 'admin' }, (ctx) => {
    const status = cleanEnum(ctx.body.status, ['open', 'resolved', 'dismissed'], 'Le statut');
    const res = db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, toId(ctx.params.id));
    if (!res.changes) throw new HttpError(404, 'Signalement introuvable.');
    return { ok: true };
  });

  r('DELETE', '/api/admin/demo', { auth: 'admin' }, () => {
    const res = db.prepare('DELETE FROM shops WHERE demo = 1').run();
    return { removed: res.changes };
  });

  return routes;
}
