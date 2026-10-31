import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CATEGORIES } from './config.js';
import { hashPassword } from './auth.js';
import { normalize } from './util.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','seller')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  city TEXT NOT NULL,
  category TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','suspended')),
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shops_status ON shops(status);
CREATE INDEX IF NOT EXISTS idx_shops_user ON shops(user_id);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '📦',
  color TEXT NOT NULL DEFAULT '#eef3f5',
  image TEXT,
  search TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','hidden')),
  views INTEGER NOT NULL DEFAULT 0,
  contacts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_id);
CREATE INDEX IF NOT EXISTS idx_products_listing ON products(status, category, created_at);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export function openDb(config) {
  fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });
  const db = new DatabaseSync(path.join(config.dataDir, 'misyve.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function categoryStyle(name) {
  return CATEGORIES.find((c) => c.name === name) || CATEGORIES[CATEGORIES.length - 1];
}

export function searchText(parts) {
  return normalize(parts.filter(Boolean).join(' '));
}

/** Recalcule le texte de recherche de tous les produits d'une boutique (après un changement de nom/ville). */
export function reindexShopProducts(db, shopId) {
  const shop = db.prepare('SELECT name, city FROM shops WHERE id = ?').get(shopId);
  if (!shop) return;
  const rows = db.prepare('SELECT id, name, category, description FROM products WHERE shop_id = ?').all(shopId);
  const upd = db.prepare('UPDATE products SET search = ? WHERE id = ?');
  for (const p of rows) upd.run(searchText([p.name, p.category, p.description, shop.name, shop.city]), p.id);
}

/** Crée le compte administrateur au premier démarrage. */
export async function ensureAdmin(db, config, log = console) {
  const exists = db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
  if (exists) return null;
  const email = (config.adminEmail || 'admin@misyve.local').toLowerCase();
  const generated = !config.adminPassword;
  const password = config.adminPassword || randomBytes(9).toString('base64url');
  if (password.length < 8) throw new Error('ADMIN_PASSWORD doit contenir au moins 8 caractères.');
  db.prepare('INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?,?,?,?,?)').run(
    email, 'Administrateur', await hashPassword(password), 'admin', new Date().toISOString(),
  );
  log.log('──────────────────────────────────────────────');
  log.log(' Compte administrateur créé');
  log.log(`   e-mail       : ${email}`);
  if (generated) {
    log.log(`   mot de passe : ${password}   (note-le puis change-le dans ton espace)`);
  } else {
    log.log('   mot de passe : celui de ADMIN_PASSWORD');
  }
  log.log('──────────────────────────────────────────────');
  return { email, password: generated ? password : null };
}

const DEMO_SHOPS = [
  { name: 'Tech Mada', city: 'Mahajanga', category: 'Téléphones', phone: '034 12 345 67', address: 'Centre-ville', description: 'Accessoires et équipements mobiles.' },
  { name: 'Mada Informatique', city: 'Mahajanga', category: 'Informatique', phone: '032 45 678 90', address: 'Bord de mer', description: 'Matériel et accessoires informatiques.' },
  { name: 'Mobile Center', city: 'Antananarivo', category: 'Téléphones', phone: '033 11 222 33', address: 'Analakely', description: 'Téléphones et accessoires.' },
  { name: 'Kanto Shop', city: 'Toamasina', category: 'Mode', phone: '034 55 666 77', address: 'Centre-ville', description: 'Sacs, vêtements et chaussures.' },
  { name: 'Épicerie Soa', city: 'Mahajanga', category: 'Alimentation', phone: '038 00 111 22', address: 'Bazary Be', description: 'Produits alimentaires du quotidien.' },
  { name: 'Électricité Plus', city: 'Antsirabe', category: 'Maison', phone: '034 77 888 99', address: 'Avenue principale', description: 'Éclairage et petit matériel électrique.' },
];

const DEMO_PRODUCTS = [
  ['Écouteurs Bluetooth', 'Téléphones', 45000, 'Tech Mada', 'Écouteurs sans fil pour musique et appels. Plusieurs modèles disponibles selon arrivage.', 0],
  ['Clavier AZERTY USB', 'Informatique', 38000, 'Mada Informatique', 'Clavier filaire AZERTY pour ordinateur. Contactez la boutique pour confirmer le modèle.', 0],
  ['Smartphone Android', 'Téléphones', 320000, 'Mobile Center', 'Smartphone Android, capacité et modèle à confirmer directement auprès du vendeur.', 1],
  ['Sac à dos quotidien', 'Mode', 65000, 'Kanto Shop', 'Sac à dos pour les cours et les déplacements. Différents coloris selon stock.', 1],
  ['Riz local — 1 kg', 'Alimentation', 3500, 'Épicerie Soa', 'Riz local vendu au détail. Le prix peut varier selon la qualité et l’arrivage.', 0],
  ['Lampe LED rechargeable', 'Maison', 28000, 'Électricité Plus', 'Lampe LED rechargeable pour la maison. Autonomie à vérifier auprès du vendeur.', 2],
  ['Souris sans fil', 'Informatique', 25000, 'Mada Informatique', 'Souris sans fil USB pour ordinateur portable ou bureau.', 1],
  ['Chaussures sport', 'Mode', 85000, 'Kanto Shop', 'Chaussures de sport. Tailles et coloris à confirmer.', 3],
];

/** Données d'exemple (supprimables depuis l'espace admin). Uniquement si la base est vide. */
export function seedDemo(db) {
  if (db.prepare("SELECT 1 FROM meta WHERE key = 'demo_seeded'").get()) return false;
  const hasShops = !!db.prepare('SELECT 1 FROM shops LIMIT 1').get();
  tx(db, () => {
    db.prepare("INSERT INTO meta (key, value) VALUES ('demo_seeded', ?)").run(new Date().toISOString());
    if (hasShops) return;
    const ids = {};
    const insShop = db.prepare(
      `INSERT INTO shops (user_id, name, owner, city, category, phone, address, description, status, demo, created_at, updated_at)
       VALUES (NULL,?,?,?,?,?,?,?, 'approved', 1, ?, ?)`,
    );
    const now = new Date().toISOString();
    for (const s of DEMO_SHOPS) {
      ids[s.name] = Number(insShop.run(s.name, s.name, s.city, s.category, s.phone, s.address, s.description, now, now).lastInsertRowid);
    }
    const insProd = db.prepare(
      `INSERT INTO products (shop_id, name, category, price, description, emoji, color, search, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    DEMO_PRODUCTS.forEach(([name, category, price, shop, description, daysAgo], i) => {
      const style = categoryStyle(category);
      const shopRow = DEMO_SHOPS.find((s) => s.name === shop);
      const emoji = { 'Écouteurs Bluetooth': '🎧', 'Clavier AZERTY USB': '⌨️', 'Sac à dos quotidien': '🎒', 'Riz local — 1 kg': '🍚', 'Lampe LED rechargeable': '💡', 'Souris sans fil': '🖱️', 'Chaussures sport': '👟' }[name] || style.emoji;
      const date = new Date(Date.now() - daysAgo * 86_400_000 - i * 60_000).toISOString();
      insProd.run(ids[shop], name, category, price, description, emoji, style.color, searchText([name, category, description, shop, shopRow.city]), date, date);
    });
  });
  return !hasShops;
}
