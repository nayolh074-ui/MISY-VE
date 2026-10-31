'use strict';

/* ════════════════════════════════════════════════════════════
   MISY VE ? — interface web (communique avec l'API /api)
   ════════════════════════════════════════════════════════════ */

const PAGE_SIZE = 12;
const CITIES = ['Mahajanga', 'Antananarivo', 'Toamasina', 'Antsirabe', 'Fianarantsoa', 'Toliara', 'Antsiranana', 'Autre'];
const CATEGORIES = ['Téléphones', 'Informatique', 'Maison', 'Alimentation', 'Mode', 'Autre'];
const REPORT_REASONS = ['Prix incorrect', 'Produit indisponible', 'Contact invalide', 'Contenu inapproprié', 'Autre'];
const SHOP_STATUS = { pending: ['En attente', 'b-orange'], approved: ['Validée', 'b-green'], rejected: ['Refusée', 'b-red'], suspended: ['Suspendue', 'b-grey'] };
const PRODUCT_STATUS = { approved: ['Publié', 'b-green'], hidden: ['Masqué', 'b-grey'] };
const REPORT_STATUS = { open: ['À traiter', 'b-orange'], resolved: ['Traité', 'b-green'], dismissed: ['Ignoré', 'b-grey'] };

const $ = (id) => document.getElementById(id);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n || 0).toLocaleString('fr-FR') + ' Ar';
const badge = ([label, cls]) => `<span class="badge ${cls}">${esc(label)}</span>`;
const options = (list, selected) => list.map((v) => `<option${v === selected ? ' selected' : ''}>${esc(v)}</option>`).join('');
const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function relativeDate(iso) {
  if (!iso) return 'Non précisé';
  const d = new Date(iso);
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86400000);
  if (days <= 0) return "Aujourd'hui";
  if (days === 1) return 'Hier';
  if (days < 7) return `Il y a ${days} jours`;
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}
const fmtDate = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

/* ───────── API ───────── */

async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'misyve', ...headers } };
  if (raw) opts.body = raw;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch('/api' + path, opts); } catch { throw new Error('Connexion impossible. Vérifie ta connexion Internet.'); }
  let data = null;
  if (res.status !== 204) { try { data = await res.json(); } catch { /* corps vide */ } }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Une erreur est survenue. Réessaie dans un instant.');
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ───────── Modales ───────── */

function openModal(id) {
  $(id).classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  const first = $(id).querySelector('input:not([type=hidden]),select,textarea');
  if (first && id !== 'dashboard-modal' && id !== 'product-modal') setTimeout(() => first.focus(), 50);
}
function closeModal(el) {
  el.classList.add('hidden');
  if (el.id === 'product-modal' && location.hash.startsWith('#produit-')) history.replaceState(null, '', location.pathname + location.search);
  if (!document.querySelector('.modal-backdrop:not(.hidden)')) document.body.style.overflow = '';
}
function showFormError(id, msg) {
  const el = $(id);
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}
async function withBusy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } finally { if (btn) btn.disabled = false; }
}

/* ════════════════ CATALOGUE PUBLIC ════════════════ */

const filters = { q: '', city: 'Toutes les villes', category: 'Tout', sort: 'recent' };
let items = [];
let page = 1;
let pages = 1;
let seq = 0;

function cardHTML(p) {
  const visual = p.image
    ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">`
    : `<span class="emoji">${esc(p.emoji || '📦')}</span>`;
  return `<article class="product-card"><div class="product-visual" style="background:${esc(p.color || '#f3f7f8')}"><span class="category-tag">${esc(p.category)}</span><span class="availability">À confirmer</span>${visual}</div><div class="product-info"><h3>${esc(p.name)}</h3><div class="shop-line">⌖ ${esc(p.shop.name)} · ${esc(p.shop.city)}</div><div class="product-price">${money(p.price)}</div><div class="product-meta"><span>Mis à jour : ${esc(relativeDate(p.updatedAt))}</span><button data-product="${p.id}">Voir détails →</button></div></div></article>`;
}
const skeletonHTML = () => Array.from({ length: 8 }, () => '<article class="product-card skeleton"><div class="product-visual"></div><div class="product-info"><div class="skeleton-line" style="width:80%"></div><div class="skeleton-line" style="width:55%"></div><div class="skeleton-line" style="width:35%"></div></div></article>').join('');

function renderProducts(total) {
  const grid = $('product-grid');
  grid.innerHTML = items.map(cardHTML).join('');
  $('empty-state').classList.toggle('hidden', items.length !== 0);
  grid.classList.toggle('hidden', items.length === 0);
  $('results-count').textContent = `${total} produit${total > 1 ? 's' : ''} trouvé${total > 1 ? 's' : ''}`;
  $('load-more').classList.toggle('hidden', page >= pages);
}

async function loadProducts({ append = false } = {}) {
  const mySeq = ++seq;
  const nextPage = append ? page + 1 : 1;
  const grid = $('product-grid');
  const btn = $('load-more');
  if (!append) { grid.classList.remove('hidden'); $('empty-state').classList.add('hidden'); grid.innerHTML = skeletonHTML(); }
  else btn.disabled = true;
  const params = new URLSearchParams({ sort: filters.sort, page: nextPage, limit: PAGE_SIZE });
  if (filters.q) params.set('q', filters.q);
  if (filters.city !== 'Toutes les villes') params.set('city', filters.city);
  if (filters.category !== 'Tout') params.set('category', filters.category);
  try {
    const data = await api('/products?' + params);
    if (mySeq !== seq) return;
    items = append ? items.concat(data.items) : data.items;
    page = data.page;
    pages = data.pages;
    renderProducts(data.total);
  } catch (e) {
    if (mySeq !== seq) return;
    if (!append) {
      grid.classList.remove('hidden');
      grid.innerHTML = `<div class="catalog-error" style="grid-column:1/-1">${esc(e.message)}<br><button class="btn btn-outline" id="retry-load">Réessayer</button></div>`;
      $('retry-load').onclick = () => loadProducts();
    } else toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

/* ───────── Fiche produit ───────── */

function waNumber(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('261')) return d;
  if (d.startsWith('0')) return '261' + d.slice(1);
  return d.length === 9 ? '261' + d : d;
}

function productDetailHTML(p) {
  const tel = String(p.shop.phone || '').replace(/[^\d+]/g, '');
  const wa = waNumber(p.shop.phone);
  const msg = encodeURIComponent(`Bonjour, je suis intéressé(e) par « ${p.name} » vu sur MISY VE ?. Est-il toujours disponible ?`);
  const visual = p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)}">` : esc(p.emoji || '📦');
  return `<div class="product-detail"><div class="detail-visual" style="background:${esc(p.color || '#f1f7f6')}">${visual}</div><div class="detail-copy"><div class="eyebrow">${esc(p.category)}</div><h2>${esc(p.name)}</h2><div class="detail-price">${money(p.price)}</div><p>${esc(p.description || "Contactez le vendeur pour plus d'informations.").replace(/\n/g, '<br>')}</p>
  <div class="detail-shop"><b>${esc(p.shop.name)}</b><br>⌖ ${esc(p.shop.address ? p.shop.address + ', ' : '')}${esc(p.shop.city)}<br>☎ ${esc(p.shop.phone || 'Contact non renseigné')}<br><small>Information mise à jour : ${esc(relativeDate(p.updatedAt))}</small></div>
  <div class="detail-actions"><a class="btn btn-primary" data-contact href="tel:${esc(tel)}">☎ Appeler le vendeur</a><a class="btn btn-whatsapp" data-contact target="_blank" rel="noopener" href="https://wa.me/${esc(wa)}?text=${msg}">WhatsApp</a></div>
  <div class="detail-extra"><button data-share="${p.id}" data-name="${esc(p.name)}">↗ Partager</button></div>
  <details class="report-box"><summary>Signaler un problème</summary><form id="report-form" data-id="${p.id}"><select name="reason" required>${options(REPORT_REASONS)}</select><textarea name="details" rows="2" maxlength="300" placeholder="Précisions (facultatif)"></textarea><button class="btn btn-outline btn-sm" type="submit">Envoyer le signalement</button></form></details>
  <p class="form-footnote">Prix et disponibilité indicatifs : confirme-les directement auprès du commerçant avant de te déplacer.</p></div></div>`;
}

async function showProduct(id) {
  const host = $('product-detail-content');
  host.innerHTML = '<div style="padding:60px;text-align:center;color:#8b9aa3">Chargement…</div>';
  openModal('product-modal');
  history.replaceState(null, '', '#produit-' + id);
  try {
    host.innerHTML = productDetailHTML(await api('/products/' + id));
  } catch (e) {
    host.innerHTML = `<div style="padding:50px 30px;text-align:center"><h3>Produit indisponible</h3><p style="color:#8b9aa3;font-size:12px">${esc(e.message)}</p></div>`;
  }
}

async function shareProduct(id, name) {
  const url = `${location.origin}/#produit-${id}`;
  try {
    if (navigator.share) await navigator.share({ title: name, text: `${name} sur MISY VE ?`, url });
    else { await navigator.clipboard.writeText(url); toast('Lien copié !'); }
  } catch { /* partage annulé */ }
}

/* ════════════════ COMPTE / SESSION ════════════════ */

let me = { user: null, shop: null };

async function refreshMe() {
  try { me = await api('/auth/me'); } catch { me = { user: null, shop: null }; }
  updateHeader();
}
function updateHeader() {
  const label = me.user ? 'Mon espace' : 'Connexion';
  $('open-login').textContent = label;
  $('nav-login').textContent = me.user ? 'Mon espace' : 'Connexion commerçant';
  $('footer-admin').textContent = me.user ? 'Mon espace' : 'Espace pro';
}
function openAccount() {
  document.getElementById('main-nav').classList.remove('open');
  if (me.user) openDashboard();
  else openModal('login-modal');
}

async function submitLogin(e) {
  e.preventDefault();
  showFormError('login-error');
  const f = e.target;
  await withBusy(f.querySelector('button[type=submit]'), async () => {
    try {
      me = await api('/auth/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } });
      f.reset();
      updateHeader();
      closeModal($('login-modal'));
      toast(`Bienvenue ${me.user.name} !`);
      openDashboard();
    } catch (err) { showFormError('login-error', err.message); }
  });
}

async function submitSeller(e) {
  e.preventDefault();
  showFormError('seller-error');
  const f = e.target;
  const body = Object.fromEntries(new FormData(f).entries());
  await withBusy(f.querySelector('button[type=submit]'), async () => {
    try {
      me = await api('/auth/register', { method: 'POST', body });
      f.reset();
      updateHeader();
      closeModal($('seller-modal'));
      toast('Boutique enregistrée ! Elle sera visible après validation.');
      openDashboard();
    } catch (err) { showFormError('seller-error', err.message); }
  });
}

async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* déjà déconnecté */ }
  me = { user: null, shop: null };
  updateHeader();
  closeModal($('dashboard-modal'));
  toast('Tu es déconnecté.');
}

/* ════════════════ TABLEAUX DE BORD ════════════════ */

const dash = { role: null, tab: 'products', editing: null, pendingImage: null, removeImage: false, shopFilter: 'all', productQ: '', productStatus: '' };

async function openDashboard() {
  if (!me.user) return openModal('login-modal');
  dash.role = me.user.role;
  dash.tab = dash.role === 'admin' ? 'shops' : 'products';
  dash.editing = null;
  dash.pendingImage = null;
  dash.removeImage = false;
  $('dashboard-content').innerHTML = '<div style="padding:60px;text-align:center;color:#8b9aa3">Chargement…</div>';
  openModal('dashboard-modal');
  await renderDashboard();
}

async function renderDashboard() {
  const host = $('dashboard-content');
  try {
    if (dash.role === 'admin') await renderAdmin(host);
    else await renderSeller(host);
  } catch (e) {
    if (e.status === 401) {
      me = { user: null, shop: null };
      updateHeader();
      closeModal($('dashboard-modal'));
      toast('Ta session a expiré. Reconnecte-toi.');
      openModal('login-modal');
    } else {
      host.innerHTML = `<div class="notice bad">${esc(e.message)}</div><button class="btn btn-outline" data-action="reload">Réessayer</button>`;
    }
  }
}

const dashHeader = (kicker, title, sub) => `<div class="dashboard-header"><div><div class="modal-kicker">${kicker}</div><h2>${title}</h2><p>${sub}</p></div><button class="btn btn-outline btn-sm" data-action="logout">Déconnexion</button></div>`;
const tabsHTML = (tabs) => `<div class="dashboard-tabs">${tabs.map(([id, label]) => `<button class="${dash.tab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('')}</div>`;
const statCards = (list) => `<div class="stat-cards">${list.map(([n, l]) => `<div class="stat-card"><b>${Number(n).toLocaleString('fr-FR')}</b><span>${l}</span></div>`).join('')}</div>`;

function accountPanel() {
  return `<div class="dashboard-form"><h3>Changer mon mot de passe</h3><form id="password-form" class="form-grid"><label class="full">Mot de passe actuel<input name="current" type="password" required autocomplete="current-password"></label><label class="full">Nouveau mot de passe<input name="next" type="password" required minlength="8" autocomplete="new-password" placeholder="8 caractères minimum"></label><p class="form-error full hidden" id="password-error" role="alert"></p><button class="btn btn-primary full" type="submit">Mettre à jour</button></form></div>
  <p class="form-footnote">Connecté en tant que <b>${esc(me.user.email)}</b>.</p>`;
}

/* ───────── Espace vendeur ───────── */

function sellerBanner(status) {
  const map = {
    pending: ['warn', '⏳ Ta boutique est en cours de validation. Tu peux déjà préparer tes produits : ils apparaîtront dans le catalogue dès la validation.'],
    approved: ['ok', '✅ Ta boutique est en ligne. Pense à confirmer régulièrement tes prix et ton stock : les acheteurs voient la date de mise à jour.'],
    rejected: ['bad', '❌ Ta boutique a été refusée. Vérifie tes informations dans « Ma boutique » et enregistre-les pour la soumettre à nouveau.'],
    suspended: ['bad', '⛔ Ta boutique est suspendue. Contacte l\'équipe MISY VE ? pour en savoir plus.'],
  };
  const [cls, text] = map[status] || map.pending;
  return `<div class="notice ${cls}">${text}</div>`;
}

function sellerProductsPanel(products) {
  const rows = products.map((p) => {
    const live = p.status === 'approved' && p.shopStatus === 'approved';
    const st = p.status === 'hidden' ? badge(PRODUCT_STATUS.hidden) : live ? badge(PRODUCT_STATUS.approved) : badge(['En attente', 'b-orange']);
    return `<tr><td><b>${esc(p.name)}</b><small>${esc(p.category)}</small></td><td>${money(p.price)}</td><td>${st}</td><td>${p.views} · ${p.contacts}<small>vues · contacts</small></td><td>${esc(relativeDate(p.updatedAt))}</td><td class="dash-actions"><button class="dash-action" data-action="touch-product" data-id="${p.id}" title="Prix et stock toujours valables">✓ À jour</button><button class="dash-action" data-action="edit-product" data-id="${p.id}">Modifier</button><button class="dash-action danger" data-action="delete-product" data-id="${p.id}">Supprimer</button></td></tr>`;
  }).join('');
  return `<div class="dash-toolbar"><button class="btn btn-primary btn-sm" data-action="new-product">＋ Ajouter un produit</button></div>
  <div class="dashboard-table-wrap"><table class="dash-table"><thead><tr><th>Produit</th><th>Prix</th><th>Statut</th><th>Audience</th><th>Mis à jour</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty-row">Aucun produit pour le moment. Ajoute ton premier produit !</td></tr>'}</tbody></table></div>`;
}

function sellerFormPanel(products) {
  const p = dash.editing ? products.find((x) => x.id === dash.editing) : null;
  const hasImg = p && p.image && !dash.removeImage;
  const preview = dash.pendingImage ? `<img src="${esc(dash.previewUrl)}" alt="">` : hasImg ? `<img src="${esc(p.image)}" alt="">` : esc(p ? p.emoji : '📷');
  return `<div class="dashboard-form"><h3>${p ? 'Modifier le produit' : '＋ Ajouter un produit'}</h3>
  <form id="product-form" class="form-grid" data-id="${p ? p.id : ''}">
    <label>Nom du produit<input name="name" required minlength="2" maxlength="100" value="${esc(p ? p.name : '')}" placeholder="Ex. : Chargeur USB-C"></label>
    <label>Catégorie<select name="category">${options(CATEGORIES, p ? p.category : '')}</select></label>
    <label>Prix en ariary<input name="price" type="number" min="0" max="1000000000" inputmode="numeric" required value="${p ? p.price : ''}" placeholder="25000"></label>
    <label class="full">Description<textarea name="description" rows="3" maxlength="600" placeholder="Modèle, état, quantité, couleurs…">${esc(p ? p.description : '')}</textarea></label>
    <div class="image-field"><div class="image-preview" id="image-preview">${preview}</div><div class="image-info"><b>Photo du produit</b> (facultatif)<br>JPG, PNG ou WebP — elle est réduite automatiquement.<br><input type="file" id="product-image" accept="image/jpeg,image/png,image/webp">${hasImg || dash.pendingImage ? '<button type="button" class="dash-action danger" data-action="remove-image">Retirer la photo</button>' : ''}</div></div>
    <p class="form-error full hidden" id="product-error" role="alert"></p>
    <button class="btn btn-primary full" type="submit">${p ? 'Enregistrer les modifications' : 'Publier le produit →'}</button>
    ${p ? '<button class="btn btn-outline full" type="button" data-action="cancel-edit">Annuler</button>' : ''}
  </form></div>`;
}

function sellerShopPanel(shop) {
  return `<div class="dashboard-form"><h3>Informations de la boutique</h3><form id="shop-form" class="form-grid">
    <label>Nom de la boutique<input name="name" required maxlength="80" value="${esc(shop.name)}"></label>
    <label>Responsable<input name="owner" required maxlength="80" value="${esc(shop.owner)}"></label>
    <label>Ville<select name="city">${options(CITIES, shop.city)}</select></label>
    <label>Catégorie<select name="category">${options(CATEGORIES, shop.category)}</select></label>
    <label class="full">Téléphone / WhatsApp (affiché publiquement)<input name="phone" type="tel" required maxlength="30" value="${esc(shop.phone)}"></label>
    <label class="full">Adresse ou quartier<input name="address" maxlength="150" value="${esc(shop.address)}"></label>
    <label class="full">Description<textarea name="description" rows="3" maxlength="500">${esc(shop.description)}</textarea></label>
    <p class="form-error full hidden" id="shop-error" role="alert"></p>
    <button class="btn btn-primary full" type="submit">Enregistrer</button></form></div>`;
}

async function renderSeller(host) {
  const data = await api('/seller/overview');
  const { shop, products, totals } = data;
  me.shop = shop;
  let panel;
  if (dash.tab === 'form') panel = sellerFormPanel(products);
  else if (dash.tab === 'shop') panel = sellerShopPanel(shop);
  else if (dash.tab === 'account') panel = accountPanel();
  else panel = sellerProductsPanel(products);
  host.innerHTML = `${dashHeader('ESPACE COMMERÇANT', esc(shop.name), `${esc(shop.city)} · ${badge(SHOP_STATUS[shop.status])}`)}
  ${sellerBanner(shop.status)}${statCards([[totals.products, 'Produits'], [totals.views, 'Vues'], [totals.contacts, 'Contacts']])}
  ${tabsHTML([['products', `Mes produits (${totals.products})`], ['form', dash.editing ? 'Modifier' : 'Ajouter'], ['shop', 'Ma boutique'], ['account', 'Compte']])}
  <div id="dash-panel">${panel}</div>`;
}

async function saveProduct(form) {
  showFormError('product-error');
  const id = form.dataset.id;
  const body = Object.fromEntries(new FormData(form).entries());
  await withBusy(form.querySelector('button[type=submit]'), async () => {
    try {
      const saved = id
        ? await api(`/seller/products/${id}`, { method: 'PUT', body })
        : await api('/seller/products', { method: 'POST', body });
      if (dash.pendingImage) {
        await api(`/seller/products/${saved.id}/image`, { method: 'PUT', raw: dash.pendingImage, headers: { 'Content-Type': 'image/jpeg' } });
      } else if (dash.removeImage && saved.image) {
        await api(`/seller/products/${saved.id}/image`, { method: 'DELETE' });
      }
      toast(id ? 'Produit mis à jour.' : 'Produit ajouté !');
      dash.editing = null; dash.pendingImage = null; dash.removeImage = false; dash.tab = 'products';
      await renderDashboard();
      loadProducts();
    } catch (err) { showFormError('product-error', err.message); }
  });
}

async function resizeImage(file, max = 900) {
  if (!/^image\//.test(file.type)) throw new Error('Choisis une image (JPG, PNG ou WebP).');
  let src, w, h;
  if (window.createImageBitmap) {
    src = await createImageBitmap(file);
    w = src.width; h = src.height;
  } else {
    src = await new Promise((ok, ko) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ko(new Error('Image illisible.')); im.src = URL.createObjectURL(file); });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const scale = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  if (!blob) throw new Error('Impossible de préparer cette image.');
  return blob;
}

/* ───────── Administration ───────── */

async function renderAdmin(host) {
  const ov = await api('/admin/overview');
  host.innerHTML = `${dashHeader('TABLEAU DE BORD', 'Administration', 'Valider les boutiques, modérer les produits et suivre l\'activité.')}
  ${statCards([[ov.shops.pending, 'Boutiques en attente'], [ov.shops.approved, 'Boutiques validées'], [ov.products.visible, 'Produits visibles'], [ov.openReports, 'Signalements ouverts'], [ov.views, 'Vues'], [ov.contacts, 'Contacts']])}
  ${tabsHTML([['shops', `Boutiques${ov.shops.pending ? ` (${ov.shops.pending})` : ''}`], ['products', 'Produits'], ['reports', `Signalements${ov.openReports ? ` (${ov.openReports})` : ''}`], ['settings', 'Paramètres']])}
  <div id="dash-panel"></div>`;
  dash.overview = ov;
  await renderAdminPanel();
}

async function renderAdminPanel() {
  const panel = $('dash-panel');
  if (!panel) return;
  if (dash.tab === 'shops') {
    panel.innerHTML = `<div class="dash-toolbar"><select id="shop-filter" aria-label="Filtrer par statut"><option value="all">Toutes les boutiques</option>${Object.entries(SHOP_STATUS).map(([k, [l]]) => `<option value="${k}"${dash.shopFilter === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div><div id="dash-table"></div>`;
    $('dash-table').innerHTML = await adminShopsTable();
  } else if (dash.tab === 'products') {
    panel.innerHTML = `<div class="dash-toolbar"><input id="admin-q" type="search" placeholder="Rechercher un produit ou une boutique…" value="${esc(dash.productQ)}"><select id="admin-pstatus" aria-label="Statut"><option value="">Tous les statuts</option><option value="approved"${dash.productStatus === 'approved' ? ' selected' : ''}>Publiés</option><option value="hidden"${dash.productStatus === 'hidden' ? ' selected' : ''}>Masqués</option></select></div><div id="dash-table"></div>`;
    $('dash-table').innerHTML = await adminProductsTable();
  } else if (dash.tab === 'reports') {
    panel.innerHTML = await adminReportsTable();
  } else {
    const ov = dash.overview;
    panel.innerHTML = `${accountPanel()}${ov.demoShops ? `<div class="dashboard-form"><h3>Données d'exemple</h3><p class="form-footnote" style="margin-top:0">${ov.demoShops} boutiques fictives (avec leurs produits) sont encore dans le catalogue. Supprime-les avant le vrai lancement.</p><button class="dash-action danger" data-action="delete-demo">Supprimer les données d'exemple</button></div>` : ''}`;
  }
}

async function adminShopsTable() {
  const q = dash.shopFilter === 'all' ? '' : `?status=${dash.shopFilter}`;
  const { items: shops } = await api('/admin/shops' + q);
  const rows = shops.map((s) => `<tr><td><b>${esc(s.name)}</b>${s.demo ? ' <span class="badge b-grey">démo</span>' : ''}<small>${esc(s.owner)}${s.email ? ' · ' + esc(s.email) : ''}</small></td><td>${esc(s.city)}<small>${esc(s.category)}</small></td><td>${esc(s.phone)}<small>${s.productsCount} produit${s.productsCount > 1 ? 's' : ''}</small></td><td>${badge(SHOP_STATUS[s.status])}<small>${fmtDate(s.createdAt)}</small></td><td class="dash-actions">${s.status !== 'approved' ? `<button class="dash-action" data-action="shop-status" data-status="approved" data-id="${s.id}">Valider</button>` : ''}${s.status === 'pending' ? `<button class="dash-action danger" data-action="shop-status" data-status="rejected" data-id="${s.id}">Refuser</button>` : ''}${s.status === 'approved' ? `<button class="dash-action danger" data-action="shop-status" data-status="suspended" data-id="${s.id}">Suspendre</button>` : ''}<button class="dash-action danger" data-action="delete-shop" data-id="${s.id}">Supprimer</button></td></tr>`).join('');
  return `<div class="dashboard-table-wrap"><table class="dash-table"><thead><tr><th>Boutique</th><th>Ville</th><th>Contact</th><th>Statut</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty-row">Aucune boutique.</td></tr>'}</tbody></table></div>`;
}

async function adminProductsTable() {
  const params = new URLSearchParams({ limit: 50 });
  if (dash.productQ) params.set('q', dash.productQ);
  if (dash.productStatus) params.set('status', dash.productStatus);
  const data = await api('/admin/products?' + params);
  const rows = data.items.map((p) => `<tr><td><b>${esc(p.name)}</b>${p.openReports ? ` <span class="badge b-orange">${p.openReports} signalement${p.openReports > 1 ? 's' : ''}</span>` : ''}<small>${esc(p.category)}</small></td><td>${esc(p.shop.name)}<small>${badge(SHOP_STATUS[p.shop.status])}</small></td><td>${money(p.price)}</td><td>${badge(PRODUCT_STATUS[p.status])}<small>${p.views} vues · ${p.contacts} contacts</small></td><td class="dash-actions"><button class="dash-action" data-action="product-status" data-status="${p.status === 'approved' ? 'hidden' : 'approved'}" data-id="${p.id}">${p.status === 'approved' ? 'Masquer' : 'Publier'}</button><button class="dash-action danger" data-action="delete-product-admin" data-id="${p.id}">Supprimer</button></td></tr>`).join('');
  return `<div class="dashboard-table-wrap"><table class="dash-table"><thead><tr><th>Produit</th><th>Boutique</th><th>Prix</th><th>Statut</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty-row">Aucun produit.</td></tr>'}</tbody></table></div>${data.total > data.items.length ? `<p class="form-footnote">${data.items.length} sur ${data.total} produits affichés : utilise la recherche pour affiner.</p>` : ''}`;
}

async function adminReportsTable() {
  const { items: reports } = await api('/admin/reports');
  const rows = reports.map((r) => `<tr><td><b>${esc(r.product.name)}</b><small>${esc(r.shopName)}</small></td><td>${esc(r.reason)}<small>${esc(r.details)}</small></td><td>${badge(REPORT_STATUS[r.status])}<small>${fmtDate(r.createdAt)}</small></td><td class="dash-actions">${r.status === 'open' ? `<button class="dash-action" data-action="report-status" data-status="resolved" data-id="${r.id}">Traité</button><button class="dash-action" data-action="report-status" data-status="dismissed" data-id="${r.id}">Ignorer</button>` : `<button class="dash-action" data-action="report-status" data-status="open" data-id="${r.id}">Rouvrir</button>`}<button class="dash-action danger" data-action="hide-reported" data-id="${r.product.id}">Masquer le produit</button></td></tr>`).join('');
  return `<div class="dashboard-table-wrap"><table class="dash-table"><thead><tr><th>Produit</th><th>Motif</th><th>Statut</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty-row">Aucun signalement. 🎉</td></tr>'}</tbody></table></div>`;
}

/* ───────── Actions du tableau de bord (délégation) ───────── */

async function runAction(btn) {
  const { action, id, status } = btn.dataset;
  const rerender = async (msg) => { if (msg) toast(msg); await renderDashboard(); loadProducts(); };
  try {
    switch (action) {
      case 'logout': return await logout();
      case 'reload': return await renderDashboard();
      case 'new-product': dash.editing = null; dash.pendingImage = null; dash.removeImage = false; dash.tab = 'form'; return await renderDashboard();
      case 'edit-product': dash.editing = Number(id); dash.pendingImage = null; dash.removeImage = false; dash.tab = 'form'; return await renderDashboard();
      case 'cancel-edit': dash.editing = null; dash.pendingImage = null; dash.removeImage = false; dash.tab = 'products'; return await renderDashboard();
      case 'remove-image': dash.pendingImage = null; dash.removeImage = true; return await renderDashboard();
      case 'touch-product': await api(`/seller/products/${id}/touch`, { method: 'POST' }); return await rerender('Prix et stock confirmés.');
      case 'delete-product':
        if (!confirm('Supprimer définitivement ce produit ?')) return;
        await api(`/seller/products/${id}`, { method: 'DELETE' }); return await rerender('Produit supprimé.');
      case 'shop-status': await api(`/admin/shops/${id}`, { method: 'PATCH', body: { status } }); return await rerender('Statut de la boutique mis à jour.');
      case 'delete-shop':
        if (!confirm('Supprimer cette boutique, son compte et tous ses produits ? Cette action est définitive.')) return;
        await api(`/admin/shops/${id}`, { method: 'DELETE' }); return await rerender('Boutique supprimée.');
      case 'product-status': await api(`/admin/products/${id}`, { method: 'PATCH', body: { status } }); return await rerender('Produit mis à jour.');
      case 'hide-reported': await api(`/admin/products/${id}`, { method: 'PATCH', body: { status: 'hidden' } }); return await rerender('Produit masqué.');
      case 'delete-product-admin':
        if (!confirm('Supprimer définitivement ce produit ?')) return;
        await api(`/admin/products/${id}`, { method: 'DELETE' }); return await rerender('Produit supprimé.');
      case 'report-status': await api(`/admin/reports/${id}`, { method: 'PATCH', body: { status } }); return await rerender();
      case 'delete-demo': {
        if (!confirm('Supprimer toutes les boutiques et produits d\'exemple ?')) return;
        const r = await api('/admin/demo', { method: 'DELETE' });
        return await rerender(`${r.removed} boutiques d'exemple supprimées.`);
      }
      default:
    }
  } catch (e) {
    if (e.status === 401) return renderDashboard();
    toast(e.message);
  }
}

async function onDashboardSubmit(e) {
  const form = e.target;
  if (!form.id) return;
  e.preventDefault();
  if (form.id === 'product-form') return saveProduct(form);
  if (form.id === 'shop-form') {
    showFormError('shop-error');
    return withBusy(form.querySelector('button[type=submit]'), async () => {
      try {
        await api('/seller/shop', { method: 'PUT', body: Object.fromEntries(new FormData(form).entries()) });
        toast('Boutique mise à jour.');
        await renderDashboard();
        loadProducts();
      } catch (err) { showFormError('shop-error', err.message); }
    });
  }
  if (form.id === 'password-form') {
    showFormError('password-error');
    return withBusy(form.querySelector('button[type=submit]'), async () => {
      try {
        await api('/auth/password', { method: 'POST', body: { current: form.current.value, next: form.next.value } });
        form.reset();
        toast('Mot de passe modifié.');
      } catch (err) { showFormError('password-error', err.message); }
    });
  }
}

async function onDashboardChange(e) {
  const t = e.target;
  if (t.id === 'product-image' && t.files && t.files[0]) {
    try {
      dash.pendingImage = await resizeImage(t.files[0]);
      dash.removeImage = false;
      if (dash.previewUrl) URL.revokeObjectURL(dash.previewUrl);
      dash.previewUrl = URL.createObjectURL(dash.pendingImage);
      // On garde les champs déjà saisis : seule l'aperçu est mis à jour.
      $('image-preview').innerHTML = `<img src="${esc(dash.previewUrl)}" alt="">`;
    } catch (err) { toast(err.message); t.value = ''; }
  } else if (t.id === 'shop-filter') {
    dash.shopFilter = t.value;
    $('dash-table').innerHTML = await adminShopsTable();
  } else if (t.id === 'admin-pstatus') {
    dash.productStatus = t.value;
    $('dash-table').innerHTML = await adminProductsTable();
  }
}

const onAdminSearch = debounce(async (value) => {
  dash.productQ = value.trim();
  const table = $('dash-table');
  if (table) table.innerHTML = await adminProductsTable();
}, 300);

/* ════════════════ INITIALISATION ════════════════ */

function applyHeroSearch(e) {
  e.preventDefault();
  filters.q = $('hero-query').value.trim();
  filters.city = $('hero-city').value;
  $('catalog-query').value = filters.q;
  $('city-filter').value = filters.city;
  loadProducts();
  $('catalogue').scrollIntoView({ behavior: 'smooth' });
}

async function loadMeta() {
  try {
    const m = await api('/meta');
    if (m.stats.products > 0) {
      $('hero-stats').innerHTML = `<strong>${m.stats.products} produit${m.stats.products > 1 ? 's' : ''}</strong> chez ${m.stats.shops} boutique${m.stats.shops > 1 ? 's' : ''} locale${m.stats.shops > 1 ? 's' : ''}`;
    }
  } catch { /* non bloquant */ }
}

function openFromHash() {
  const m = /^#produit-(\d+)$/.exec(location.hash);
  if (m) showProduct(m[1]);
}

document.addEventListener('DOMContentLoaded', () => {
  $('year').textContent = new Date().getFullYear();

  // Recherche et filtres
  $('hero-search').addEventListener('submit', applyHeroSearch);
  $('catalog-query').addEventListener('input', debounce((e) => { filters.q = e.target.value.trim(); loadProducts(); }));
  $('city-filter').addEventListener('change', (e) => { filters.city = e.target.value; loadProducts(); });
  $('sort-select').addEventListener('change', (e) => { filters.sort = e.target.value; loadProducts(); });
  $('category-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-category]');
    if (!b) return;
    filters.category = b.dataset.category;
    document.querySelectorAll('.category-chip').forEach((x) => x.classList.toggle('selected', x === b));
    loadProducts();
  });
  document.querySelectorAll('[data-search]').forEach((b) => b.addEventListener('click', () => {
    $('hero-query').value = b.dataset.search;
    $('catalog-query').value = b.dataset.search;
    filters.q = b.dataset.search;
    loadProducts();
    $('catalogue').scrollIntoView({ behavior: 'smooth' });
  }));
  $('reset-filters').addEventListener('click', () => {
    Object.assign(filters, { q: '', city: 'Toutes les villes', category: 'Tout' });
    $('catalog-query').value = '';
    $('hero-query').value = '';
    $('city-filter').value = 'Toutes les villes';
    document.querySelectorAll('.category-chip').forEach((x) => x.classList.toggle('selected', x.dataset.category === 'Tout'));
    loadProducts();
  });
  $('load-more').addEventListener('click', () => loadProducts({ append: true }));
  $('product-grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-product]');
    if (b) showProduct(b.dataset.product);
  });

  // Fiche produit
  $('product-detail-content').addEventListener('click', (e) => {
    const contact = e.target.closest('[data-contact]');
    const id = (location.hash.match(/#produit-(\d+)/) || [])[1];
    if (contact && id) api(`/products/${id}/contact`, { method: 'POST' }).catch(() => {});
    const share = e.target.closest('[data-share]');
    if (share) shareProduct(share.dataset.share, share.dataset.name);
  });
  $('product-detail-content').addEventListener('submit', async (e) => {
    if (e.target.id !== 'report-form') return;
    e.preventDefault();
    const f = e.target;
    await withBusy(f.querySelector('button'), async () => {
      try {
        await api(`/products/${f.dataset.id}/report`, { method: 'POST', body: { reason: f.reason.value, details: f.details.value } });
        f.closest('details').innerHTML = '<summary>Signalement envoyé</summary><p>Merci ! Notre équipe va vérifier cette annonce.</p>';
      } catch (err) { toast(err.message); }
    });
  });

  // Comptes
  $('login-form').addEventListener('submit', submitLogin);
  $('seller-form').addEventListener('submit', submitSeller);
  ['open-seller', 'cta-seller'].forEach((id) => $(id).addEventListener('click', () => (me.user ? openAccount() : openModal('seller-modal'))));
  ['open-login', 'footer-admin'].forEach((id) => $(id).addEventListener('click', openAccount));
  $('nav-login').addEventListener('click', (e) => { e.preventDefault(); openAccount(); });
  document.querySelectorAll('[data-switch]').forEach((b) => b.addEventListener('click', () => {
    closeModal($('login-modal'));
    openModal(b.dataset.switch);
  }));

  // Tableaux de bord
  const host = $('dashboard-content');
  host.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { dash.tab = tab.dataset.tab; if (dash.tab !== 'form') dash.editing = null; return renderDashboard(); }
    const btn = e.target.closest('[data-action]');
    if (btn) runAction(btn);
  });
  host.addEventListener('submit', onDashboardSubmit);
  host.addEventListener('change', onDashboardChange);
  host.addEventListener('input', (e) => { if (e.target.id === 'admin-q') onAdminSearch(e.target.value); });

  // Modales
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.closest('.modal-backdrop'))));
  document.querySelectorAll('.modal-backdrop').forEach((m) => m.addEventListener('mousedown', (e) => { if (e.target === m) closeModal(m); }));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll('.modal-backdrop:not(.hidden)')].pop();
    if (open) closeModal(open);
  });
  window.addEventListener('hashchange', openFromHash);

  // Navigation
  document.querySelectorAll('[data-scroll]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    $(a.dataset.scroll).scrollIntoView({ behavior: 'smooth' });
    $('main-nav').classList.remove('open');
  }));
  document.querySelectorAll('[data-view="home"]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
  $('mobile-menu').addEventListener('click', () => {
    const open = $('main-nav').classList.toggle('open');
    $('mobile-menu').setAttribute('aria-expanded', String(open));
  });

  refreshMe();
  loadMeta();
  loadProducts();
  openFromHash();
});
