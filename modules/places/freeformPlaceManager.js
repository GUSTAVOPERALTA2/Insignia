/**
 * modules/places/freeformPlaceManager.js
 * 
 * Maneja lugares "freeform" (no catalogados):
 * - Guarda nuevos lugares en lugares.json
 * - Recarga el índice de lugares
 * - Evita duplicados
 */

const fs = require('fs');
const path = require('path');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

// Ruta por defecto del catálogo
const DEFAULT_CATALOG_PATH = path.join(process.cwd(), 'data', 'lugares.json');

// Normalización para comparación
function norm(s) {
  return (s || '')
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Verifica si un lugar ya existe en el catálogo
 */
function placeExistsInCatalog(catalog, placeLabel) {
  const normalizedNew = norm(placeLabel);
  
  return catalog.some(item => {
    // Comparar con label
    if (norm(item.label) === normalizedNew) return true;
    
    // Comparar con aliases
    if (Array.isArray(item.aliases)) {
      if (item.aliases.some(alias => norm(alias) === normalizedNew)) return true;
    }
    
    return false;
  });
}

/**
 * Infiere el tipo de lugar basado en el nombre
 */
function inferPlaceType(placeLabel) {
  const t = norm(placeLabel);
  
  // Baños
  if (/\b(bano|baños|sanitario|wc|restroom|toilet|mingitorio)\b/.test(t)) {
    return 'bathroom';
  }
  
  // Áreas de empleados
  if (/\b(locker|lokers|vestidor|colegas|colaboradores|empleados|staff|back\s*house|boh)\b/.test(t)) {
    return 'staff_area';
  }
  
  // Cocina/Alimentos
  if (/\b(cocina|kitchen|comedor|cafeteria)\b/.test(t)) {
    return 'kitchen';
  }
  
  // Oficinas
  if (/\b(oficina|office|administracion|rh|contabilidad)\b/.test(t)) {
    return 'office';
  }
  
  // Áreas comunes
  if (/\b(lobby|recepcion|front|pasillo|elevador|escalera)\b/.test(t)) {
    return 'common_area';
  }
  
  // Exteriores
  if (/\b(jardin|terraza|azotea|roof|playa|muelle|estacionamiento|parking)\b/.test(t)) {
    return 'outdoor';
  }
  
  // Servicios
  if (/\b(spa|gym|gimnasio|alberca|pool|piscina|restaurante|bar)\b/.test(t)) {
    return 'amenity';
  }
  
  // Torres/Edificios
  if (/\b(torre|edificio|bloque|ala)\b/.test(t)) {
    return 'building';
  }
  
  return 'other';
}

/**
 * Genera aliases automáticos para un lugar
 */
function generateAliases(placeLabel) {
  const aliases = [];
  const t = norm(placeLabel);
  
  // Si tiene "de", agregar versión sin "de"
  // "Baños de Colegas" → "Baños Colegas"
  if (t.includes(' de ')) {
    aliases.push(placeLabel.replace(/\s+de\s+/gi, ' '));
  }
  
  // Si tiene "del", agregar versión sin "del"
  if (t.includes(' del ')) {
    aliases.push(placeLabel.replace(/\s+del\s+/gi, ' '));
  }
  
  // Versiones con typos comunes
  if (t.includes('locker')) {
    aliases.push(placeLabel.replace(/locker/gi, 'loker'));
  }
  if (t.includes('loker')) {
    aliases.push(placeLabel.replace(/loker/gi, 'locker'));
  }
  
  // Sin acentos (ya normalizado)
  const noAccents = placeLabel
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (noAccents !== placeLabel) {
    aliases.push(noAccents);
  }
  
  return [...new Set(aliases.filter(a => a && a !== placeLabel))];
}

/**
 * Crea un nuevo registro de lugar para el catálogo
 */
function createPlaceRecord(placeLabel, options = {}) {
  const type = options.type || inferPlaceType(placeLabel);
  const aliases = options.aliases || generateAliases(placeLabel);
  
  const record = {
    label: placeLabel,
    type: type,
    source: 'freeform',
    added_at: new Date().toISOString(),
  };
  
  // Agregar aliases si hay
  if (aliases.length > 0) {
    record.aliases = aliases;
  }
  
  // Metadata opcional
  if (options.building) record.building = options.building;
  if (options.floor) record.floor = options.floor;
  if (options.area) record.area = options.area;
  if (options.notes) record.notes = options.notes;
  
  return record;
}

/**
 * Lee el catálogo de lugares
 */
function readCatalog(catalogPath = DEFAULT_CATALOG_PATH) {
  try {
    if (!fs.existsSync(catalogPath)) {
      if (DEBUG) console.warn('[FREEFORM] catalog not found, creating empty:', catalogPath);
      return [];
    }
    
    const raw = fs.readFileSync(catalogPath, 'utf8');
    const data = JSON.parse(raw);
    
    if (!Array.isArray(data)) {
      if (DEBUG) console.warn('[FREEFORM] catalog is not an array');
      return [];
    }
    
    return data;
  } catch (e) {
    if (DEBUG) console.error('[FREEFORM] error reading catalog:', e?.message);
    return [];
  }
}

/**
 * Escribe el catálogo de lugares
 */
function writeCatalog(catalog, catalogPath = DEFAULT_CATALOG_PATH) {
  try {
    // Crear backup antes de escribir
    if (fs.existsSync(catalogPath)) {
      const backupPath = catalogPath.replace('.json', '.backup.json');
      fs.copyFileSync(catalogPath, backupPath);
    }
    
    // Escribir con formato legible
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), 'utf8');
    
    if (DEBUG) console.log('[FREEFORM] catalog saved', { total: catalog.length, path: catalogPath });
    return true;
  } catch (e) {
    if (DEBUG) console.error('[FREEFORM] error writing catalog:', e?.message);
    return false;
  }
}

/**
 * Agrega un lugar freeform al catálogo si no existe
 * 
 * @param {string} placeLabel - Nombre del lugar
 * @param {Object} options - Opciones adicionales
 * @param {string} options.catalogPath - Ruta al catálogo
 * @param {string} options.type - Tipo de lugar
 * @param {string[]} options.aliases - Aliases adicionales
 * @param {boolean} options.reloadIndex - Si debe recargar el índice de placeExtractor
 * @returns {Object} { added: boolean, record: object|null, reason: string }
 */
async function addFreeformPlace(placeLabel, options = {}) {
  const {
    catalogPath = DEFAULT_CATALOG_PATH,
    reloadIndex = true,
  } = options;
  
  if (!placeLabel || typeof placeLabel !== 'string') {
    return { added: false, record: null, reason: 'invalid_label' };
  }
  
  const cleanLabel = placeLabel.trim();
  if (cleanLabel.length < 2) {
    return { added: false, record: null, reason: 'label_too_short' };
  }
  
  // Leer catálogo actual
  const catalog = readCatalog(catalogPath);
  
  // Verificar si ya existe
  if (placeExistsInCatalog(catalog, cleanLabel)) {
    if (DEBUG) console.log('[FREEFORM] place already exists:', cleanLabel);
    return { added: false, record: null, reason: 'already_exists' };
  }
  
  // Crear registro
  const record = createPlaceRecord(cleanLabel, options);
  
  // Agregar al catálogo
  catalog.push(record);
  
  // Guardar
  const saved = writeCatalog(catalog, catalogPath);
  if (!saved) {
    return { added: false, record: null, reason: 'save_failed' };
  }
  
  if (DEBUG) {
    console.log('[FREEFORM] place added', {
      label: cleanLabel,
      type: record.type,
      aliases: record.aliases || [],
    });
  }
  
  // Recargar índice de placeExtractor si está disponible
  if (reloadIndex) {
    try {
      const { loadLocationCatalogIfNeeded } = require('../ai/placeExtractor');
      // Forzar recarga limpiando la caché interna
      // Nota: placeExtractor verifica si la ruta cambió, así que pasamos una ruta ligeramente diferente
      // y luego la correcta para forzar recarga
      await loadLocationCatalogIfNeeded(catalogPath + '?reload=' + Date.now());
    } catch (e) {
      // Si falla, no es crítico - el índice se recargará en el próximo reinicio
      if (DEBUG) console.warn('[FREEFORM] could not reload index:', e?.message);
    }
  }
  
  return { added: true, record, reason: 'success' };
}

/**
 * Verifica si un lugar es freeform (no catalogado)
 * Útil para saber si se debe agregar después de guardar
 */
async function isPlaceFreeform(placeLabel, catalogPath = DEFAULT_CATALOG_PATH) {
  const catalog = readCatalog(catalogPath);
  return !placeExistsInCatalog(catalog, placeLabel);
}

/**
 * Obtiene estadísticas del catálogo
 */
function getCatalogStats(catalogPath = DEFAULT_CATALOG_PATH) {
  const catalog = readCatalog(catalogPath);
  
  const stats = {
    total: catalog.length,
    byType: {},
    bySource: {},
    freeformCount: 0,
  };
  
  for (const item of catalog) {
    // Por tipo
    const type = item.type || 'unknown';
    stats.byType[type] = (stats.byType[type] || 0) + 1;
    
    // Por fuente
    const source = item.source || 'original';
    stats.bySource[source] = (stats.bySource[source] || 0) + 1;
    
    // Contar freeform
    if (item.source === 'freeform') {
      stats.freeformCount++;
    }
  }
  
  return stats;
}

module.exports = {
  addFreeformPlace,
  isPlaceFreeform,
  placeExistsInCatalog,
  readCatalog,
  writeCatalog,
  createPlaceRecord,
  inferPlaceType,
  generateAliases,
  getCatalogStats,
  DEFAULT_CATALOG_PATH,
};