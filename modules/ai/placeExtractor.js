// modules/ai/placeExtractor.js
// ✅ MEJORADO v2: 
// - Fuzzy search para sugerencias
// - Validación estricta (rechaza texto que no parece lugar)
// - Más palabras genéricas filtradas
// - Función isValidPlaceCandidate exportada

const fs = require('fs');
const path = require('path');

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';
const DEFAULT_AI_MODEL = process.env.VICEBOT_AI_MODEL_PLACE || 'gpt-4o-mini';

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

/* ──────────────────────────────
 * Utilidades de normalización
 * ────────────────────────────── */
function _norm(s) {
  return (s || '')
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _uniq(arr) { return Array.from(new Set(arr || [])); }
function _isRoomToken(s) { return /^\d{4}$/.test(String(s || '')); }
function _extractRooms(text) {
  const m = (text || '').match(/\b\d{4}\b/g);
  return _uniq(m || []);
}

/* ──────────────────────────────
 * ✅ NUEVO: Distancia de Levenshtein para fuzzy matching
 * ────────────────────────────── */
function levenshteinDistance(a, b) {
  const matrix = [];
  const aLen = a.length;
  const bLen = b.length;

  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  for (let i = 0; i <= bLen; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= aLen; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= bLen; i++) {
    for (let j = 1; j <= aLen; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // sustitución
          matrix[i][j - 1] + 1,     // inserción
          matrix[i - 1][j] + 1      // eliminación
        );
      }
    }
  }

  return matrix[bLen][aLen];
}

function similarityScore(a, b) {
  const A = _norm(a);
  const B = _norm(b);
  if (!A && !B) return 1;
  if (!A || !B) return 0;
  
  const maxLen = Math.max(A.length, B.length);
  const distance = levenshteinDistance(A, B);
  return 1 - (distance / maxLen);
}

/* ──────────────────────────────
 * ✅ NUEVO: Palabras/patrones inválidos como lugar
 * ────────────────────────────── */
const GENERIC_WORDS = new Set([
  // Palabras genéricas de lugar
  'habitacion', 'cuarto', 'lugar', 'sitio', 'area', 'zona',
  'espacio', 'seccion', 'parte', 'lado', 'punto',
  // Artículos y preposiciones solos
  'el', 'la', 'los', 'las', 'un', 'una', 'en', 'de', 'del',
  // Respuestas vagas
  'aqui', 'ahi', 'alli', 'alla', 'cerca', 'lejos',
  'arriba', 'abajo', 'adentro', 'afuera',
  // Palabras sin sentido como lugar
  'cosa', 'algo', 'nada', 'todo', 'esto', 'eso',
  // Saludos/expresiones
  'hola', 'gracias', 'ok', 'si', 'no', 'bueno', 'malo',
  'bien', 'mal', 'ayuda', 'help', 'porfa', 'porfavor',
]);

// Patrones que claramente NO son lugares
const INVALID_PLACE_PATTERNS = [
  /^[^a-z0-9]+$/i,           // Solo símbolos
  /^.{1,2}$/,                 // Muy corto (1-2 chars)
  /^[0-9]{1,3}$/,             // Números cortos (no son habitación)
  /^[0-9]{5,}$/,              // Números muy largos
  /^\d+[a-z]$/i,              // Como "5a", "3b" solos
  /^(jaja|jeje|lol|xd|wtf)/i, // Risas/expresiones
  /^(no\s+se|nose|nosé)$/i,   // "no sé"
  /[!?]{2,}/,                 // Múltiples signos
];

/**
 * ✅ NUEVO: Valida si un texto PODRÍA ser un lugar válido
 * Retorna { valid: boolean, reason?: string }
 */
function isValidPlaceCandidate(text) {
  if (!text) return { valid: false, reason: 'empty' };
  
  const raw = String(text).trim();
  if (!raw) return { valid: false, reason: 'empty' };
  
  const normalized = _norm(raw);
  if (!normalized) return { valid: false, reason: 'empty_after_norm' };
  
  // Verificar longitud
  if (normalized.length < 2) {
    return { valid: false, reason: 'too_short' };
  }
  if (normalized.length > 100) {
    return { valid: false, reason: 'too_long' };
  }
  
  // Verificar palabras genéricas
  if (GENERIC_WORDS.has(normalized)) {
    return { valid: false, reason: 'generic_word' };
  }
  
  // Verificar patrones inválidos
  for (const pattern of INVALID_PLACE_PATTERNS) {
    if (pattern.test(raw) || pattern.test(normalized)) {
      return { valid: false, reason: 'invalid_pattern' };
    }
  }
  
  // Verificar si es número de habitación válido (4 dígitos)
  if (/^\d{4}$/.test(normalized)) {
    return { valid: true, reason: 'room_number' };
  }
  
  // Verificar si contiene patrón de villa
  if (/villa\s*\d+/i.test(raw)) {
    return { valid: true, reason: 'villa_pattern' };
  }
  
  // Verificar si contiene "hab" + número
  if (/hab(itacion)?\s*\d+/i.test(raw)) {
    return { valid: true, reason: 'room_pattern' };
  }
  
  // Por defecto, aceptar si tiene al menos una letra
  if (/[a-z]/i.test(normalized)) {
    return { valid: true, reason: 'has_letters' };
  }
  
  return { valid: false, reason: 'no_letters' };
}

/* ──────────────────────────────
 * Catálogo e índices
 * ────────────────────────────── */
let _loadedPath = null;
let _catalog = [];
let _roomsIndex = new Map();
let _phraseIndex = [];
let _stats = { total: 0, nameIndex: 0, aliasPhrases: 0, roomsIndexed: 0 };

function _pushPhrase(term, item, seen) {
  const t = _norm(term);
  if (!t || seen.has(t)) return;
  seen.add(t);
  _phraseIndex.push({ term: t, item });
}

function _buildIndexes(catalog) {
  _roomsIndex.clear();
  _phraseIndex.length = 0;
  _stats = { total: catalog.length, nameIndex: 0, aliasPhrases: 0, roomsIndexed: 0 };

  for (const item of catalog) {
    if (item.room_number && _isRoomToken(item.room_number)) {
      _roomsIndex.set(String(item.room_number), item);
      _stats.roomsIndexed++;
    }
    const seen = new Set();
    if (item.label) {
      _pushPhrase(item.label, item, seen);
      _stats.nameIndex++;
    }
    if (Array.isArray(item.aliases)) {
      for (const a of item.aliases) {
        _pushPhrase(a, item, seen);
        _stats.aliasPhrases++;
      }
    }
  }
}

function _readJson(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

async function loadLocationCatalogIfNeeded(catalogPath) {
  const resolved = catalogPath || path.join(process.cwd(), 'data', 'lugares.json');
  if (_loadedPath === resolved && _catalog.length) return;

  if (!fs.existsSync(resolved)) {
    throw new Error(`Catálogo de lugares no encontrado: ${resolved}`);
  }
  const data = _readJson(resolved);
  if (!Array.isArray(data)) throw new Error('Catálogo inválido: se esperaba un arreglo JSON');

  _catalog = data;
  _loadedPath = resolved;
  _buildIndexes(_catalog);

  if (DEBUG) {
    console.log('[PLACE] index.ready', {
      total: _stats.total,
      nameIndex: _stats.nameIndex,
      aliasPhrases: _stats.aliasPhrases,
      roomsIndexed: _stats.roomsIndexed
    });
  }
}

/* ──────────────────────────────
 * Escaneo de habitaciones
 * ────────────────────────────── */
function _scanRoomsFirst(text) {
  const raw = (text || '').toString();
  const rooms = _extractRooms(raw);
  const matched = rooms.filter(r => _roomsIndex.has(r));
  if (matched.length) {
    const r = matched[0];
    const item = _roomsIndex.get(r);
    return {
      found: true, via: 'room',
      item, token: r, score: 1.0
    };
  }
  return { found: false, via: 'room', rooms, matched };
}

/* ──────────────────────────────
 * Escaneo de frases (match exacto)
 * ────────────────────────────── */

// Palabras cortas que parecen respuestas/confirmaciones, NO lugares
const SHORT_RESPONSE_WORDS = new Set([
  'si', 'sis', 'sip', 'sep', 'sii', 'siii',  // variantes de "sí"
  'no', 'nop', 'nel', 'noo', 'nooo',          // variantes de "no"
  'ok', 'oks', 'oky', 'oka',                   // variantes de "ok"
  'va', 'vale', 'dale', 'sale',                // confirmaciones
  'ya', 'aja', 'mhm', 'mmm',                   // interjecciones
  'que', 'como', 'quien', 'donde',             // preguntas
  'hola', 'hey', 'ey', 'oye',                  // saludos
  'gracias', 'thx', 'ty',                      // agradecimientos
]);

function _scanPhrases(text, { maxCandidates = 10, strictMode = false } = {}) {
  const N = _norm(text);
  
  // Filtrar palabras genéricas sin contexto
  if (GENERIC_WORDS.has(N)) {
    if (DEBUG) console.log('[PLACE] skip generic word without context:', N);
    return [];
  }
  
  // ✅ FIX: Filtrar palabras cortas que parecen respuestas, no lugares
  if (SHORT_RESPONSE_WORDS.has(N)) {
    if (DEBUG) console.log('[PLACE] skip short response word:', N);
    return [];
  }
  
  // ✅ FIX: No aceptar textos muy cortos (< 4 chars) como lugares
  // a menos que sean números de habitación
  if (N.length < 4 && !/^\d{4}$/.test(N)) {
    if (DEBUG) console.log('[PLACE] skip too short text:', N);
    return [];
  }
  
  // ✅ FIX: Si el texto es muy largo (parece una oración), NO buscar substrings
  // Solo buscar matches exactos o casi exactos
  const isLongText = N.length > 25 || N.split(' ').length > 4;
  
  const hits = [];
  for (const { term, item } of _phraseIndex) {
    // ✅ FIX: Evitar matches de términos muy cortos dentro de texto largo
    // Por ejemplo, evitar que "si" (de "Sistemas") matchee con "habitacion"
    if (term.length < 4 && isLongText) {
      continue; // Skip términos muy cortos en textos largos
    }
    
    let matched = false;
    let matchQuality = 0;
    
    // Match exacto (máxima prioridad)
    if (N === term) {
      matched = true;
      matchQuality = 100;
    }
    // El término es una palabra completa dentro del texto
    else if (!isLongText) {
      // Solo para textos cortos: verificar si el término aparece como palabra completa
      const termWords = term.split(' ');
      const textWords = N.split(' ');
      
      // Verificar si TODAS las palabras del término están en el texto
      const allWordsPresent = termWords.every(tw => 
        textWords.some(txtW => txtW === tw || txtW.startsWith(tw) || tw.startsWith(txtW))
      );
      
      if (allWordsPresent && termWords.length > 0) {
        matched = true;
        // Score basado en qué porcentaje del texto es el término
        matchQuality = (term.length / N.length) * 50;
      }
    }
    // ✅ Para textos largos: solo match si el término aparece como frase completa
    else if (isLongText) {
      // Buscar el término como palabra/frase completa (con word boundaries)
      const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (regex.test(N) && term.length >= 5) {
        matched = true;
        matchQuality = term.length * 2;
      }
    }
    
    if (matched) {
      const exactMatch = (N === term) ? 50 : 0;
      const lengthScore = term.length;
      const score = exactMatch + lengthScore + matchQuality;
      hits.push({ item, via: 'phrase', term, score, matchQuality });
    }
  }
  
  // ✅ Filtrar hits con score muy bajo
  const filteredHits = hits.filter(h => h.score >= 5);
  
  filteredHits.sort((a, b) => b.score - a.score);
  return filteredHits.slice(0, maxCandidates);
}

/* ──────────────────────────────
 * ✅ NUEVO: Búsqueda fuzzy
 * ────────────────────────────── */
function _fuzzySearch(text, { maxCandidates = 5, minSimilarity = 0.6 } = {}) {
  const N = _norm(text);
  
  // No buscar palabras genéricas
  if (GENERIC_WORDS.has(N)) {
    return [];
  }
  
  // No buscar textos muy cortos o muy largos
  if (N.length < 3 || N.length > 50) {
    return [];
  }
  
  const hits = [];
  const seen = new Set();
  
  for (const { term, item } of _phraseIndex) {
    // Evitar duplicados por label
    if (seen.has(item.label)) continue;
    
    const sim = similarityScore(N, term);
    if (sim >= minSimilarity) {
      seen.add(item.label);
      hits.push({ 
        item, 
        via: 'fuzzy', 
        term, 
        score: sim,
        similarity: sim 
      });
    }
  }
  
  // También buscar en labels directamente
  for (const item of _catalog) {
    if (seen.has(item.label)) continue;
    
    const labelNorm = _norm(item.label);
    const sim = similarityScore(N, labelNorm);
    if (sim >= minSimilarity) {
      seen.add(item.label);
      hits.push({ 
        item, 
        via: 'fuzzy_label', 
        term: labelNorm, 
        score: sim,
        similarity: sim 
      });
    }
  }
  
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, maxCandidates);
}

/* ──────────────────────────────
 * IA para lugares informales
 * ────────────────────────────── */
function placeAISchema() {
  return {
    name: 'Vicebot_Place_Informal_v2',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        found: { type: 'boolean' },
        canonical_label: { type: ['string', 'null'] },
        room_number: { type: ['string', 'null'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        rationale: { type: ['string', 'null'] }
      },
      required: ['found', 'canonical_label', 'room_number', 'confidence', 'rationale']
    }
  };
}

function _buildAIMessages({ text, candidates }) {
  // Obtener algunos ejemplos del catálogo real
  const sampleLabels = _catalog.slice(0, 20).map(c => c.label).join(', ');
  
  const system = `Eres un asistente de un hotel que interpreta lugares mencionados de forma informal.

LUGARES DEL CATÁLOGO (ejemplos reales):
${sampleLabels}

TAREA:
El usuario dijo algo como "mi cuarto", "la alberca", "el lobby". Debes:
1. Si hay número de habitación (4 dígitos) → úsalo
2. Si dice "mi cuarto"/"mi habitación" → necesitas el número, retorna found=false
3. Si dice "lobby"/"recepción" → "Front Desk"
4. Si dice "alberca"/"piscina" → buscar equivalente en candidatos
5. Si el texto NO parece un lugar (ej: "perro", "hola", "123") → found=false
6. Si no estás seguro → found=false

IMPORTANTE: Solo retorna found=true si estás MUY seguro de que el texto refiere a un lugar real del hotel.

Responde SOLO JSON según el schema.`;

  const candList = candidates.map(c => ({
    label: c.item.label,
    via: c.via,
    score: c.score
  }));

  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify({ text, candidates: candList }) }
  ];
}

async function _aiInformalPlace({ text, candidates, model = DEFAULT_AI_MODEL }) {
  const c = await client();
  if (!c) return null;

  // ✅ Pre-validación: no llamar a IA con texto claramente inválido
  const validation = isValidPlaceCandidate(text);
  if (!validation.valid) {
    if (DEBUG) console.log('[PLACE AI] skip invalid candidate:', { text, reason: validation.reason });
    return { found: false, confidence: 0, rationale: `Invalid: ${validation.reason}` };
  }

  try {
    const schema = placeAISchema();
    const resp = await c.responses.create({
      model,
      input: _buildAIMessages({ text, candidates }),
      temperature: 0.1,
      max_output_tokens: 200,
      text: {
        format: {
          type: 'json_schema',
          name: schema.name,
          schema: schema.schema,
          strict: schema.strict
        }
      }
    });

    const out = resp.output_text ? JSON.parse(resp.output_text) : null;
    if (!out) return null;

    if (DEBUG) console.log('[PLACE AI] informal.out', out);
    return out;
  } catch (e) {
    if (DEBUG) console.warn('[PLACE AI] informal.err', e?.message || e);
    return null;
  }
}

/* ──────────────────────────────
 * ✅ API PRINCIPAL (mejorada v2)
 * ────────────────────────────── */
async function detectPlace(text, opts = {}) {
  const {
    preferRoomsFirst = true,
    useAI = true,
    useFuzzy = true,
    aiModel = DEFAULT_AI_MODEL,
    debugReturn = true,
    fuzzyMinSim = 0.65,
    strictValidation = true,
  } = opts;

  const raw = (text || '').toString().trim();
  if (DEBUG) console.log('[PLACE] detect.start', { text: raw });

  // ✅ NUEVO: Validación temprana
  if (strictValidation) {
    const validation = isValidPlaceCandidate(raw);
    if (!validation.valid) {
      if (DEBUG) console.log('[PLACE] reject invalid candidate:', { text: raw, reason: validation.reason });
      return {
        found: false,
        reason: 'invalid_input',
        validationReason: validation.reason,
        candidates: [],
        ai: { used: false }
      };
    }
  }

  // 1) Números de habitación (prioridad máxima)
  if (preferRoomsFirst) {
    const roomScan = _scanRoomsFirst(raw);
    if (roomScan.found) {
      const it = roomScan.item;
      const meta = {
        building: it.building || it.tower || null,
        floor: it.floor || null,
        room: it.room_number || roomScan.token
      };
      if (DEBUG) console.log('[PLACE] room.hit', { label: it.label });
      return {
        found: true,
        label: it.label,
        via: 'room',
        score: 1,
        meta,
        candidates: debugReturn ? [{ label: it.label, via: 'room', score: 1 }] : undefined,
        ai: { used: false }
      };
    }
    
    // ✅ Si el texto es un número de 4 dígitos pero NO está en catálogo
    // Aún así es válido como habitación
    const roomMatch = raw.match(/\b(\d{4})\b/);
    if (roomMatch) {
      const roomNum = roomMatch[1];
      if (DEBUG) console.log('[PLACE] room.pattern (not in catalog)', { room: roomNum });
      return {
        found: true,
        label: `Habitación ${roomNum}`,
        via: 'room_pattern',
        score: 0.9,
        meta: { room: roomNum },
        candidates: debugReturn ? [{ label: `Habitación ${roomNum}`, via: 'room_pattern', score: 0.9 }] : undefined,
        ai: { used: false }
      };
    }
  }

  // 2) Frases del catálogo (match exacto)
  let phraseHits = _scanPhrases(raw);
  let candidates = phraseHits;

  // 3) Si hay 1 candidato con match exacto → retornar
  if (candidates.length === 1) {
    const c = candidates[0];
    const it = c.item;
    const meta = {
      building: it.building || it.tower || null,
      floor: it.floor || null,
      room: it.room_number || null
    };
    if (DEBUG) console.log('[PLACE] phrase.single_hit', { label: it.label });
    return {
      found: true,
      label: it.label,
      via: c.via,
      score: c.score,
      meta,
      candidates: debugReturn ? candidates.map(k => ({ label: k.item.label, via: k.via, score: k.score })) : undefined,
      ai: { used: false }
    };
  }

  // 4) Si hay múltiples candidatos → ver si uno es claramente mejor
  if (candidates.length > 1) {
    const top = candidates[0];
    const second = candidates[1];
    // Si el top tiene score mucho mayor, usarlo
    if (top.score >= second.score * 1.5 || _norm(raw) === top.term) {
      const it = top.item;
      const meta = {
        building: it.building || it.tower || null,
        floor: it.floor || null,
        room: it.room_number || null
      };
      if (DEBUG) console.log('[PLACE] phrase.top_hit', { label: it.label, score: top.score });
      return {
        found: true,
        label: it.label,
        via: top.via,
        score: top.score,
        meta,
        candidates: debugReturn ? candidates.map(k => ({ label: k.item.label, via: k.via, score: k.score })) : undefined,
        ai: { used: false }
      };
    }
  }

  // 5) Búsqueda fuzzy
  if (useFuzzy && !candidates.length) {
    const fuzzyHits = _fuzzySearch(raw, { minSimilarity: fuzzyMinSim });
    if (fuzzyHits.length) {
      candidates = fuzzyHits;
      if (DEBUG) console.log('[PLACE] fuzzy.hits', fuzzyHits.map(h => ({ label: h.item.label, sim: h.similarity })));
      
      // Si hay un match fuzzy muy bueno (>0.85), aceptarlo
      const top = fuzzyHits[0];
      if (top.similarity >= 0.85) {
        const it = top.item;
        const meta = {
          building: it.building || it.tower || null,
          floor: it.floor || null,
          room: it.room_number || null
        };
        if (DEBUG) console.log('[PLACE] fuzzy.accept', { label: it.label, similarity: top.similarity });
        return {
          found: true,
          label: it.label,
          via: 'fuzzy',
          score: top.similarity,
          meta,
          candidates: debugReturn ? candidates.map(k => ({ label: k.item.label, via: k.via, score: k.score })) : undefined,
          ai: { used: false }
        };
      }
    }
  }

  // 6) IA para lugares informales (último recurso)
  if (useAI && !candidates.length) {
    const aiRes = await _aiInformalPlace({ text: raw, candidates: [], model: aiModel });
    if (aiRes?.found && aiRes.canonical_label) {
      // Buscar en catálogo el label canónico
      const match = _catalog.find(c => 
        _norm(c.label) === _norm(aiRes.canonical_label) ||
        (c.room_number && c.room_number === aiRes.room_number)
      );

      if (match) {
        const meta = {
          building: match.building || match.tower || null,
          floor: match.floor || null,
          room: match.room_number || null
        };
        if (DEBUG) console.log('[PLACE] ai.match', { label: match.label, confidence: aiRes.confidence });
        return {
          found: true,
          label: match.label,
          via: 'ai_informal',
          score: aiRes.confidence,
          meta,
          candidates: debugReturn ? [{ label: match.label, via: 'ai_informal', score: aiRes.confidence }] : undefined,
          reason: 'ai_informal_mapping',
          ai: { used: true, confidence: aiRes.confidence, rationale: aiRes.rationale }
        };
      }
    }
  }

  // 7) No match - retornar candidatos fuzzy si los hay (para sugerencias)
  if (DEBUG) console.log('[PLACE] no_match', { candidatesCount: candidates.length });
  return {
    found: false,
    reason: candidates.length ? 'ambiguous' : 'no_match',
    candidates: debugReturn ? candidates.map(k => ({ 
      label: k.item.label, 
      via: k.via, 
      score: k.score,
      similarity: k.similarity 
    })) : undefined,
    ai: { used: false }
  };
}

/* ──────────────────────────────
 * ✅ NUEVO: Obtener sugerencias para un texto
 * ────────────────────────────── */
async function getSuggestions(text, { maxSuggestions = 5, minSimilarity = 0.5 } = {}) {
  const validation = isValidPlaceCandidate(text);
  if (!validation.valid) {
    return { suggestions: [], reason: validation.reason };
  }
  
  const fuzzyHits = _fuzzySearch(text, { 
    maxCandidates: maxSuggestions, 
    minSimilarity 
  });
  
  return {
    suggestions: fuzzyHits.map(h => ({
      label: h.item.label,
      similarity: h.similarity,
      room_number: h.item.room_number || null
    })),
    reason: fuzzyHits.length ? 'found' : 'no_similar'
  };
}

/* ──────────────────────────────
 * ✅ NUEVO: Verificar si un texto exacto existe en el catálogo
 * ────────────────────────────── */
function existsInCatalog(text) {
  const N = _norm(text);
  
  // Buscar en rooms
  if (_roomsIndex.has(text)) return true;
  
  // Buscar en frases
  for (const { term } of _phraseIndex) {
    if (term === N) return true;
  }
  
  return false;
}

module.exports = {
  loadLocationCatalogIfNeeded,
  detectPlace,
  isValidPlaceCandidate,
  getSuggestions,
  existsInCatalog,
};