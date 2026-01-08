// modules/state/userDirectory.js
// Directorio de usuarios (admin/user + team) basado en /data/users.json
//
// Estructura esperada:
// {
//   "5217751801318@c.us": { "nombre": "...", "cargo": "...", "rol": "admin", "team": "it" },
//   ...
// }

const fs = require('fs');
const path = require('path');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// ✅ Default: /data/users.json (tal como quieres)
// (Puedes sobreescribir con VICEBOT_USERS_PATH si un día lo mueves)
const USERS_PATH =
  process.env.VICEBOT_USERS_PATH ||
  path.join(process.cwd(), 'data', 'users.json');

let CACHE = new Map(); // waId -> { waId, nombre, cargo, rol, team }

// Normaliza ID preservando @c.us para match exacto con keys de users.json
function normalizeId(id) {
  if (!id) return null;
  return String(id).trim().toLowerCase();
}

// Extrae solo dígitos para comparación flexible
function extractDigits(id) {
  if (!id) return null;
  return String(id).replace(/\D/g, '');
}

function loadUsers() {
  try {
    let raw = fs.readFileSync(USERS_PATH, 'utf8');
    // Quitar BOM si existe
    raw = raw.replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('users.json debe ser un objeto { waId: { ... } }');
    }

    CACHE.clear();
    for (const [waId, rec] of Object.entries(data)) {
      const key = normalizeId(waId);
      if (!key) continue;
      if (!rec || typeof rec !== 'object') continue;

      CACHE.set(key, {
        waId: key,
        nombre: rec.nombre || null,
        cargo: rec.cargo || null,
        rol: rec.rol || 'user',     // admin | user
        team: rec.team || null,     // it | man | ama | exp | ...
        titulo: rec.titulo || null,
      });
    }

    if (DEBUG) console.log('[USERS] loaded', { count: CACHE.size, path: USERS_PATH });
  } catch (e) {
    console.error('[USERS] load error', e?.message || e);
    CACHE.clear();
  }
}

// Cargar al iniciar
loadUsers();

function reloadUsers() {
  loadUsers();
}

function getUser(chatId) {
  const key = normalizeId(chatId);
  if (!key) return null;
  
  // 1. Match exacto (incluye @c.us)
  if (CACHE.has(key)) {
    return CACHE.get(key);
  }
  
  // 2. Búsqueda flexible por dígitos
  const inputDigits = extractDigits(chatId);
  if (!inputDigits) return null;
  
  for (const [cachedKey, user] of CACHE.entries()) {
    const cachedDigits = extractDigits(cachedKey);
    
    // Match exacto de dígitos
    if (cachedDigits === inputDigits) return user;
    
    // Match últimos 10 dígitos (sin código de país)
    if (inputDigits.slice(-10) === cachedDigits.slice(-10)) return user;
  }
  
  return null;
}

function isKnownUser(chatId) {
  return !!getUser(chatId);
}

function isAdmin(chatId) {
  const u = getUser(chatId);
  return !!(u && u.rol === 'admin');
}

function getContext(chatId) {
  const u = getUser(chatId);
  const waId = normalizeId(chatId);

  if (!u) {
    return {
      waId,
      isKnownUser: false,
      isAdmin: false,
      rol: null,
      team: null,
      nombre: null,
      cargo: null,
    };
  }

  return {
    waId: u.waId,
    isKnownUser: true,
    isAdmin: u.rol === 'admin',
    rol: u.rol || 'user',
    team: u.team || null,
    nombre: u.nombre || null,
    cargo: u.cargo || null,
  };
}

module.exports = {
  reloadUsers,
  getUser,
  isKnownUser,
  isAdmin,
  getContext,
};