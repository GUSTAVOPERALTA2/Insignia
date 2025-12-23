// modules/utils/locationCatalog.js
// Catálogo de lugares: carga, normaliza, búsqueda y fuzzy.

const fs = require('fs');
const path = require('path');

const CATALOG_PATH = process.env.VICEBOT_LOCATIONS_PATH ||
  path.join(__dirname, '..', '..', 'data', 'lugares.json');

const MIN_SCORE = Number(process.env.CATALOG_MIN_SCORE || '0.82'); // umbral fuzzy
const MAX_CANDIDATES = 5;

let _catalog = [];
let _byId = new Map();
let _index = new Map(); // alias normalizado -> Set(ids)

// ───────── Normalización ─────────
function stripDiacritics(s) {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}
function normalizeText(s = '') {
  return stripDiacritics(String(s || '').toLowerCase())
    .replace(/\b(en|la|el|los|las|de la|de el|del|al)\b/g, ' ')
    .replace(/[^a-z0-9#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function titleCase(s='') {
  return String(s||'').replace(/\S+/g, w => w[0].toUpperCase() + w.slice(1));
}

// ───────── Jaro-Winkler (simplificado) ─────────
function jaroWinkler(a, b) {
  a = a || ''; b = b || '';
  if (a === b) return 1;
  const mt = Math.floor(Math.max(a.length, b.length) / 2) - 1;
  const aFlags = new Array(a.length).fill(false);
  const bFlags = new Array(b.length).fill(false);
  let m = 0;

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - mt);
    const end = Math.min(i + mt + 1, b.length);
    for (let j = start; j < end; j++) {
      if (!bFlags[j] && a[i] === b[j]) { aFlags[i] = bFlags[j] = true; m++; break; }
    }
  }
  if (!m) return 0;

  let k = 0, t = 0;
  for (let i = 0; i < a.length; i++) {
    if (aFlags[i]) {
      while (!bFlags[k]) k++;
      if (a[i] !== b[k++]) t++;
    }
  }
  t /= 2;

  const j = (m / a.length + m / b.length + (m - t) / m) / 3;

  let l = 0;
  for (; l < Math.min(4, a.length, b.length) && a[l] === b[l]; l++);
  return j + l * 0.1 * (1 - j);
}

// ───────── Carga/Índice ─────────
function load(filePath = CATALOG_PATH) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const arr = JSON.parse(raw);

  _catalog = arr.filter(x => x && (x.active ?? true));
  _byId = new Map();
  _index = new Map();

  for (const item of _catalog) {
    _byId.set(item.id, item);
    const labels = new Set([
      normalizeText(item.label),
      ...(Array.isArray(item.aliases) ? item.aliases.map(normalizeText) : [])
    ]);
    for (const key of labels) {
      if (!key) continue;
      if (!_index.has(key)) _index.set(key, new Set());
      _index.get(key).add(item.id);
    }
  }
  return _catalog.length;
}

// ───────── Búsqueda ─────────
function find(text) {
  const original = String(text || '').trim();
  const q = normalizeText(original);
  if (!q) return null;

  if (_index.has(q)) {
    const ids = Array.from(_index.get(q));
    const item = _byId.get(ids[0]);
    return { item, score: 1.0, via: 'exact' };
  }

  const quick = [];
  for (const [key, ids] of _index.entries()) {
    if (key.startsWith(q)) {
      for (const id of ids) quick.push({ id, score: 0.9, via: 'prefix' });
    }
  }
  if (quick.length) {
    const best = _byId.get(quick[0].id);
    return { item: best, score: quick[0].score, via: 'prefix' };
  }

  const scored = [];
  for (const item of _catalog) {
    const keys = [item.label, ...(item.aliases || [])].map(normalizeText);
    let best = 0;
    for (const k of keys) best = Math.max(best, jaroWinkler(q, k));
    scored.push({ item, score: best });
  }
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (top && top.score >= MIN_SCORE) {
    return { item: top.item, score: top.score, via: 'fuzzy' };
  }

  const candidates = scored.slice(0, MAX_CANDIDATES);
  return { item: null, score: 0, via: 'none', candidates };
}

function prettyLugar(itemOrLabel) {
  if (!itemOrLabel) return null;
  if (typeof itemOrLabel === 'string') return titleCase(itemOrLabel);
  return itemOrLabel.label || null;
}

module.exports = { load, find, prettyLugar, normalizeText, jaroWinkler };