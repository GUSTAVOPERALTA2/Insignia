// modules/ai/placeResolver.js
// ═══════════════════════════════════════════════════════════════════════════
// Sistema de resolución de lugares con 3 capas:
// 1. Búsqueda directa (fuzzy match en catálogo)
// 2. Detección de zona ambigua + desambiguación interactiva
// 3. Validación semántica con IA para lugares "libres"
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';
const DEFAULT_AI_MODEL = process.env.VICEBOT_AI_MODEL_PLACE || 'gpt-4o-mini';

// ──────────────────────────────────────────────────────────────
// OpenAI Client
// ──────────────────────────────────────────────────────────────
let _OpenAI = null, _client = null;
async function client() {
  if (!_OpenAI) {
    try { _OpenAI = (await import('openai')).default; } catch {}
  }
  if (!_client && _OpenAI && process.env.OPENAI_API_KEY) {
    _client = new _OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client || null;
}

// ──────────────────────────────────────────────────────────────
// Utilidades
// ──────────────────────────────────────────────────────────────
function norm(s) {
  return (s || '')
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRoomNumber(s) {
  return /^\d{4}$/.test(String(s || ''));
}

function extractRoomNumbers(text) {
  const matches = (text || '').match(/\b\d{4}\b/g);
  return [...new Set(matches || [])];
}

// ══════════════════════════════════════════════════════════════════════════
// ZONAS AMBIGUAS - Configuración
// ══════════════════════════════════════════════════════════════════════════

const AMBIGUOUS_ZONES = {
  // ─────────────────────────────────────────────────────────────
  // COCINAS
  // ─────────────────────────────────────────────────────────────
  cocina: {
    triggers: ['cocina', 'kitchen'],
    prompt: '🍳 Hay varias cocinas, ¿cuál es?',
    options: [
      { key: '1', label: 'Cocina Principal', canonical: 'Cocina Principal', description: 'Casero, Otro Bar, Pastelería' },
      { key: '2', label: 'Cocina Nido', canonical: 'Cocina Nido', description: 'Restaurante Nido' },
      { key: '3', label: 'Cocina Nidito', canonical: 'Cocina Nidito', description: 'Restaurante Nidito' },
      { key: '4', label: 'Cocina Cielomar', canonical: 'Cocina Cielomar', description: 'Restaurante Cielomar' },
      { key: '5', label: 'Cocina Awacate', canonical: 'Cocina Awacate', description: 'Restaurante Awacate' },
      { key: '6', label: 'Cocina Comedor', canonical: 'Cocina Comedor Colaboradores', description: 'Comedor de colaboradores' },
    ]
  },

  // ─────────────────────────────────────────────────────────────
  // ALBERCAS / PISCINAS
  // ─────────────────────────────────────────────────────────────
  alberca: {
    triggers: ['alberca', 'piscina', 'pool', 'pileta'],
    prompt: '🏊 Hay varias albercas, ¿cuál es?',
    options: [
      { key: '1', label: 'Alberca Principal', canonical: 'Alberca Principal', description: 'Alberca central del hotel' },
      { key: '2', label: 'Alberca Familiar', canonical: 'Alberca Familiar', description: 'Family Pool / Kids Pool' },
      { key: '3', label: 'Alberca Adultos', canonical: 'Alberca de Adultos (Adults Pool)', description: 'Solo adultos' },
    ]
  },

  // ─────────────────────────────────────────────────────────────
  // RESTAURANTES
  // ─────────────────────────────────────────────────────────────
  restaurante: {
    triggers: ['restaurante', 'restaurant', 'resto'],
    prompt: '🍽️ Hay varios restaurantes, ¿cuál es?',
    options: [
      { key: '1', label: 'Awacate', canonical: 'Awacate', description: '' },
      { key: '2', label: 'Nidito', canonical: 'Nidito', description: '' },
      { key: '3', label: 'Nido', canonical: 'Nido', description: '' },
      { key: '4', label: 'Cielomar', canonical: 'Cielomar', description: '' },
      { key: '5', label: 'Casero', canonical: 'Casero', description: '' },
    ]
  },

  // ─────────────────────────────────────────────────────────────
  // BARES
  // ─────────────────────────────────────────────────────────────
  bar: {
    triggers: ['bar', 'barra'],
    prompt: '🍸 Hay varios bares, ¿cuál es?',
    options: [
      { key: '1', label: 'Otro Bar', canonical: 'Otro Bar', description: 'Bar principal' },
      { key: '2', label: 'Nidito Bar', canonical: 'Nidito Bar', description: 'Bar de Nidito' },
      { key: '3', label: 'Cielomar Bar', canonical: 'Cielomar Bar', description: 'Bar de Cielomar' },
    ]
  },

  // ─────────────────────────────────────────────────────────────
  // ROOFTOPS
  // ─────────────────────────────────────────────────────────────
  rooftop: {
    triggers: ['rooftop', 'azotea', 'terraza'],
    prompt: '🌅 Hay varios rooftops, ¿cuál es?',
    options: [
      { key: '1', label: 'Rooftop F', canonical: 'Rooftop F', description: 'Torre F' },
      { key: '2', label: 'Rooftop G', canonical: 'Rooftop G', description: 'Torre G' },
    ]
  },
};

// ──────────────────────────────────────────────────────────────
// Catálogo de lugares
// ──────────────────────────────────────────────────────────────
let _catalog = [];
let _loadedPath = null;
let _roomsIndex = new Map();
let _phraseIndex = [];

function loadCatalog(catalogPath) {
  const resolved = catalogPath || path.join(process.cwd(), 'data', 'lugares.json');
  if (_loadedPath === resolved && _catalog.length) return _catalog;

  if (!fs.existsSync(resolved)) {
    throw new Error(`Catálogo de lugares no encontrado: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error('Catálogo inválido');

  _catalog = data;
  _loadedPath = resolved;
  _buildIndexes();

  if (DEBUG) {
    console.log('[PLACE-RESOLVER] catalog.loaded', { 
      total: _catalog.length,
      rooms: _roomsIndex.size,
      phrases: _phraseIndex.length 
    });
  }

  return _catalog;
}

function _buildIndexes() {
  _roomsIndex.clear();
  _phraseIndex = [];

  for (const item of _catalog) {
    // Indexar por número de habitación
    if (item.room_number && isRoomNumber(item.room_number)) {
      _roomsIndex.set(String(item.room_number), item);
    }
    if (item.villa_number) {
      _roomsIndex.set(String(item.villa_number), item);
    }

    // Indexar por label y aliases
    const seen = new Set();
    
    if (item.label) {
      const t = norm(item.label);
      if (t && !seen.has(t)) {
        seen.add(t);
        _phraseIndex.push({ term: t, item, source: 'label' });
      }
    }

    if (Array.isArray(item.aliases)) {
      for (const alias of item.aliases) {
        const t = norm(alias);
        if (t && !seen.has(t)) {
          seen.add(t);
          _phraseIndex.push({ term: t, item, source: 'alias' });
        }
      }
    }
  }

  // Ordenar por longitud de término (más largo = más específico)
  _phraseIndex.sort((a, b) => b.term.length - a.term.length);
}

// ══════════════════════════════════════════════════════════════════════════
// CAPA 1: Búsqueda directa en catálogo
// ══════════════════════════════════════════════════════════════════════════

/**
 * Busca coincidencias directas en el catálogo
 * @returns {Object} { found, item, via, score, candidates }
 */
function searchCatalog(text) {
  const normalized = norm(text);
  if (!normalized) return { found: false, reason: 'empty_input' };

  // 1. Prioridad máxima: números de habitación/villa
  const roomNumbers = extractRoomNumbers(text);
  for (const num of roomNumbers) {
    if (_roomsIndex.has(num)) {
      const item = _roomsIndex.get(num);
      return {
        found: true,
        item,
        via: 'room_number',
        score: 1.0,
        candidates: [{ label: item.label, score: 1.0 }]
      };
    }
  }

  // 2. Búsqueda por frases (label/alias)
  const candidates = [];
  
  for (const { term, item, source } of _phraseIndex) {
    // Match exacto
    if (normalized === term) {
      return {
        found: true,
        item,
        via: `exact_${source}`,
        score: 1.0,
        candidates: [{ label: item.label, score: 1.0 }]
      };
    }
    
    // Match contenido (el texto contiene el término)
    if (normalized.includes(term)) {
      const score = term.length / normalized.length;
      candidates.push({ item, term, score, via: `contains_${source}` });
    }
  }

  // Si hay candidatos, tomar el mejor (más largo/específico)
  if (candidates.length > 0) {
    // Ordenar por score descendente
    candidates.sort((a, b) => b.score - a.score);
    
    // Si hay un claro ganador (score > 0.5), retornarlo
    if (candidates[0].score > 0.5) {
      const best = candidates[0];
      return {
        found: true,
        item: best.item,
        via: best.via,
        score: best.score,
        candidates: candidates.slice(0, 5).map(c => ({ 
          label: c.item.label, 
          score: c.score 
        }))
      };
    }
    
    // Si hay múltiples candidatos similares, es ambiguo
    return {
      found: false,
      reason: 'ambiguous_candidates',
      candidates: candidates.slice(0, 5).map(c => ({ 
        label: c.item.label, 
        score: c.score 
      }))
    };
  }

  return { found: false, reason: 'no_match' };
}

// ══════════════════════════════════════════════════════════════════════════
// CAPA 2: Detección de zonas ambiguas
// ══════════════════════════════════════════════════════════════════════════

/**
 * Detecta si el texto menciona una zona ambigua genérica
 * @returns {Object|null} { zoneKey, zone, matchedTrigger } o null
 */
function detectAmbiguousZone(text) {
  const normalized = norm(text);
  
  for (const [zoneKey, zone] of Object.entries(AMBIGUOUS_ZONES)) {
    for (const trigger of zone.triggers) {
      const triggerNorm = norm(trigger);
      
      // Verificar si el texto ES solo el trigger (ej: "cocina" sin más contexto)
      // o si contiene el trigger pero NO tiene especificador
      if (normalized === triggerNorm) {
        return { zoneKey, zone, matchedTrigger: trigger, isGeneric: true };
      }
      
      // Si contiene el trigger, verificar si tiene especificador
      if (normalized.includes(triggerNorm)) {
        // Buscar si alguna opción específica matchea
        const hasSpecificMatch = zone.options.some(opt => {
          const optNorm = norm(opt.label);
          const canonicalNorm = norm(opt.canonical);
          return normalized.includes(optNorm) || normalized.includes(canonicalNorm);
        });
        
        // Si NO tiene match específico, es ambiguo
        if (!hasSpecificMatch) {
          return { zoneKey, zone, matchedTrigger: trigger, isGeneric: false };
        }
      }
    }
  }
  
  return null;
}

/**
 * Genera el mensaje de desambiguación para una zona
 */
function buildDisambiguationPrompt(zone) {
  const lines = [zone.prompt, ''];
  
  for (const opt of zone.options) {
    let line = `*${opt.key})* ${opt.label}`;
    if (opt.description) {
      line += ` — _${opt.description}_`;
    }
    lines.push(line);
  }
  
  lines.push('');
  lines.push('Responde con el *número* o escribe el nombre específico.');
  
  return lines.join('\n');
}

/**
 * Resuelve la respuesta del usuario a una desambiguación
 * @returns {Object} { resolved, canonical, label } o { resolved: false }
 */
function resolveDisambiguationResponse(zoneKey, userResponse) {
  const zone = AMBIGUOUS_ZONES[zoneKey];
  if (!zone) return { resolved: false, reason: 'invalid_zone' };
  
  const normalized = norm(userResponse);
  
  // Buscar por número
  for (const opt of zone.options) {
    if (normalized === opt.key || normalized === norm(opt.key)) {
      return {
        resolved: true,
        canonical: opt.canonical,
        label: opt.label,
        via: 'disambiguation_number'
      };
    }
  }
  
  // Buscar por nombre (parcial)
  for (const opt of zone.options) {
    const labelNorm = norm(opt.label);
    const canonicalNorm = norm(opt.canonical);
    
    if (normalized.includes(labelNorm) || labelNorm.includes(normalized) ||
        normalized.includes(canonicalNorm) || canonicalNorm.includes(normalized)) {
      return {
        resolved: true,
        canonical: opt.canonical,
        label: opt.label,
        via: 'disambiguation_name'
      };
    }
  }
  
  return { resolved: false, reason: 'no_match' };
}

// ══════════════════════════════════════════════════════════════════════════
// CAPA 3: Validación semántica con IA
// ══════════════════════════════════════════════════════════════════════════

/**
 * Valida si un texto es un lugar físico válido usando IA
 * @returns {Object} { isPlace, normalized, confidence, reason }
 */
async function validatePlaceWithAI(text, model = DEFAULT_AI_MODEL) {
  const c = await client();
  if (!c) {
    return { isPlace: false, reason: 'no_ai_client' };
  }

  const systemPrompt = `Eres un validador de lugares para un sistema de tickets de hotel.

TAREA: Determinar si el texto del usuario describe un LUGAR FÍSICO válido en un hotel/resort.

LUGARES VÁLIDOS (ejemplos):
- Habitaciones: "hab 1234", "cuarto 5401", "suite presidencial"
- Zonas: "lobby", "recepción", "pasillo piso 3", "elevador norte"
- Áreas exteriores: "junto a la fuente", "entrada principal", "estacionamiento"
- Instalaciones: "cocina", "alberca", "gym", "spa", "restaurante"
- Descripción relativa: "afuera de la 1305", "frente al elevador"

NO SON LUGARES:
- Confirmaciones: "ok", "sí", "gracias", "ya"
- Tiempos: "mañana", "ahorita", "en un rato"
- Personas: "el técnico", "mi supervisor"
- Acciones: "revisar", "arreglar"
- Respuestas vagas: "por ahí", "no sé"

Responde SOLO con JSON:
{
  "isPlace": true/false,
  "normalized": "nombre normalizado del lugar" o null,
  "confidence": 0.0-1.0,
  "reason": "explicación breve"
}`;

  try {
    const response = await c.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Texto: "${text}"` }
      ],
      temperature: 0.1,
      max_tokens: 150,
      response_format: { type: 'json_object' }
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) return { isPlace: false, reason: 'empty_response' };

    const result = JSON.parse(content);
    
    if (DEBUG) {
      console.log('[PLACE-RESOLVER] ai.validate', { text, result });
    }

    return {
      isPlace: !!result.isPlace,
      normalized: result.normalized || null,
      confidence: result.confidence || 0,
      reason: result.reason || ''
    };
  } catch (e) {
    if (DEBUG) console.warn('[PLACE-RESOLVER] ai.error', e?.message);
    return { isPlace: false, reason: 'ai_error', error: e?.message };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// API PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════

/**
 * Resuelve un lugar con el sistema de 3 capas
 * 
 * @param {string} text - Texto del usuario
 * @param {Object} opts - Opciones
 * @param {boolean} opts.useAI - Usar validación IA para lugares libres (default: true)
 * @param {boolean} opts.allowFreeform - Permitir lugares no catalogados (default: true)
 * @param {string} opts.aiModel - Modelo de IA a usar
 * 
 * @returns {Object} Resultado de la resolución:
 *   - found: true → lugar resuelto
 *   - ambiguous: true → necesita desambiguación (incluye disambiguationPrompt)
 *   - found: false → no es un lugar válido o no se pudo resolver
 */
async function resolvePlace(text, opts = {}) {
  const {
    useAI = true,
    allowFreeform = true,
    aiModel = DEFAULT_AI_MODEL
  } = opts;

  const input = (text || '').trim();
  if (!input) {
    return { found: false, reason: 'empty_input' };
  }

  if (DEBUG) console.log('[PLACE-RESOLVER] resolve.start', { text: input });

  // Asegurar que el catálogo está cargado
  try {
    loadCatalog();
  } catch (e) {
    if (DEBUG) console.warn('[PLACE-RESOLVER] catalog.error', e?.message);
  }

  // ─────────────────────────────────────────────────────────────
  // CAPA 1: Búsqueda directa en catálogo
  // ─────────────────────────────────────────────────────────────
  const catalogResult = searchCatalog(input);
  
  if (catalogResult.found) {
    const item = catalogResult.item;
    return {
      found: true,
      label: item.label,
      canonical: item.label,
      id: item.id,
      type: item.type,
      meta: {
        building: item.tower || item.structure || null,
        floor: item.floor || null,
        room: item.room_number || item.villa_number || null,
        parent: item.parent || null
      },
      via: `catalog_${catalogResult.via}`,
      score: catalogResult.score,
      source: 'catalog'
    };
  }

  // ─────────────────────────────────────────────────────────────
  // CAPA 2: Detección de zona ambigua
  // ─────────────────────────────────────────────────────────────
  const ambiguous = detectAmbiguousZone(input);
  
  if (ambiguous) {
    return {
      found: false,
      ambiguous: true,
      zoneKey: ambiguous.zoneKey,
      matchedTrigger: ambiguous.matchedTrigger,
      disambiguationPrompt: buildDisambiguationPrompt(ambiguous.zone),
      options: ambiguous.zone.options,
      reason: 'needs_disambiguation'
    };
  }

  // ─────────────────────────────────────────────────────────────
  // CAPA 3: Validación semántica con IA
  // ─────────────────────────────────────────────────────────────
  if (useAI && allowFreeform) {
    const aiResult = await validatePlaceWithAI(input, aiModel);
    
    if (aiResult.isPlace && aiResult.confidence >= 0.7) {
      return {
        found: true,
        label: aiResult.normalized || input,
        canonical: aiResult.normalized || input,
        id: null, // No está en catálogo
        type: 'freeform',
        meta: {},
        via: 'ai_validation',
        score: aiResult.confidence,
        source: 'ai_freeform',
        aiReason: aiResult.reason
      };
    }
    
    // Si la IA dice que NO es un lugar
    if (!aiResult.isPlace) {
      return {
        found: false,
        reason: 'not_a_place',
        aiReason: aiResult.reason,
        confidence: aiResult.confidence
      };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // No se pudo resolver
  // ─────────────────────────────────────────────────────────────
  return {
    found: false,
    reason: catalogResult.reason || 'unresolved',
    candidates: catalogResult.candidates || []
  };
}

/**
 * Procesa la respuesta a una desambiguación
 */
async function resolveDisambiguation(zoneKey, userResponse) {
  const result = resolveDisambiguationResponse(zoneKey, userResponse);
  
  if (result.resolved) {
    // Buscar el item en el catálogo
    const catalogResult = searchCatalog(result.canonical);
    
    if (catalogResult.found) {
      const item = catalogResult.item;
      return {
        found: true,
        label: item.label,
        canonical: result.canonical,
        id: item.id,
        type: item.type,
        meta: {
          building: item.tower || item.structure || null,
          floor: item.floor || null,
          room: item.room_number || null,
          parent: item.parent || null
        },
        via: result.via,
        source: 'disambiguation'
      };
    }
    
    // Si no está en catálogo pero se resolvió la desambiguación
    return {
      found: true,
      label: result.label,
      canonical: result.canonical,
      id: null,
      type: 'zone',
      meta: {},
      via: result.via,
      source: 'disambiguation'
    };
  }
  
  return {
    found: false,
    reason: result.reason || 'disambiguation_failed'
  };
}

// ──────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────
module.exports = {
  // API principal
  resolvePlace,
  resolveDisambiguation,
  
  // Utilidades
  loadCatalog,
  searchCatalog,
  detectAmbiguousZone,
  buildDisambiguationPrompt,
  validatePlaceWithAI,
  
  // Configuración
  AMBIGUOUS_ZONES,
};