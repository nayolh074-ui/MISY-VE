export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Minuscules + sans accents, pour une recherche tolérante ("ecouteurs" trouve "Écouteurs"). */
export function normalize(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export function cleanText(v, { field, min = 0, max = 200, required = false, multiline = false }) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${field} est obligatoire.`);
    return '';
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} est invalide.`);
  let s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  s = multiline ? s.replace(/\r\n/g, '\n').trim() : s.replace(/\s+/g, ' ').trim();
  if (required && !s) throw new HttpError(400, `${field} est obligatoire.`);
  if (s && s.length < min) throw new HttpError(400, `${field} est trop court (minimum ${min} caractères).`);
  if (s.length > max) throw new HttpError(400, `${field} est trop long (maximum ${max} caractères).`);
  return s;
}

export function cleanEmail(v) {
  const s = cleanText(v, { field: 'L’e-mail', required: true, max: 120 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw new HttpError(400, 'L’adresse e-mail n’est pas valide.');
  return s;
}

export function cleanPhone(v, { required = true } = {}) {
  const s = cleanText(v, { field: 'Le téléphone', required, max: 30 });
  if (!s) return '';
  if (!/^[0-9+\s().-]+$/.test(s)) throw new HttpError(400, 'Le téléphone ne doit contenir que des chiffres.');
  const digits = s.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 13) throw new HttpError(400, 'Le numéro de téléphone semble incorrect (ex. : 034 12 345 67).');
  return s;
}

export function cleanEnum(v, list, field, { required = true } = {}) {
  if ((v === undefined || v === null || v === '') && !required) return '';
  if (!list.includes(v)) throw new HttpError(400, `${field} est invalide.`);
  return v;
}

export function cleanPrice(v) {
  const n = typeof v === 'string' ? Number(v.replace(/\s/g, '')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1_000_000_000) {
    throw new HttpError(400, 'Le prix est invalide (en ariary, entre 0 et 1 000 000 000).');
  }
  return Math.round(n);
}

export function cleanPassword(v, field = 'Le mot de passe') {
  if (typeof v !== 'string' || v.length < 8) throw new HttpError(400, `${field} doit contenir au moins 8 caractères.`);
  if (v.length > 200) throw new HttpError(400, `${field} est trop long.`);
  return v;
}

export function toId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, 'Élément introuvable.');
  return n;
}

export function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

/** Détecte le vrai type d'image grâce aux premiers octets (on ne fait pas confiance à l'en-tête). */
export function sniffImage(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** Petit limiteur de débit en mémoire (suffisant pour une seule instance). */
export class RateLimiter {
  constructor() {
    this.hits = new Map();
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    }, 60_000);
    this.timer.unref();
  }
  check(key, max, windowMs) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset <= now) {
      e = { count: 0, reset: now + windowMs };
      this.hits.set(key, e);
    }
    e.count += 1;
    if (e.count > max) {
      const wait = Math.ceil((e.reset - now) / 60_000);
      throw new HttpError(429, `Trop de tentatives. Réessaie dans ${wait} minute${wait > 1 ? 's' : ''}.`);
    }
  }
  close() {
    clearInterval(this.timer);
  }
}
