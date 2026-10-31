import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CITIES = ['Mahajanga', 'Antananarivo', 'Toamasina', 'Antsirabe', 'Fianarantsoa', 'Toliara', 'Antsiranana', 'Autre'];

export const CATEGORIES = [
  { name: 'Téléphones', emoji: '📱', color: '#eaf1ff' },
  { name: 'Informatique', emoji: '💻', color: '#e8f6ef' },
  { name: 'Maison', emoji: '🏠', color: '#fff8d9' },
  { name: 'Alimentation', emoji: '🥬', color: '#fff5e6' },
  { name: 'Mode', emoji: '👕', color: '#f4eefa' },
  { name: 'Autre', emoji: '📦', color: '#eef3f5' },
];

export function loadConfig(env = process.env) {
  return {
    root,
    publicDir: path.join(root, 'public'),
    port: Number(env.PORT) || 3000,
    dataDir: path.resolve(env.DATA_DIR || path.join(root, 'data')),
    isProd: env.NODE_ENV === 'production',
    adminEmail: env.ADMIN_EMAIL || '',
    adminPassword: env.ADMIN_PASSWORD || '',
    seedDemo: env.SEED_DEMO !== 'false',
    trustProxy: env.TRUST_PROXY === 'true',
    sessionDays: 14,
    maxImageBytes: 2 * 1024 * 1024,
  };
}
