// modules/ai/placeExtractor.js
// ✅ MEJORADO: Usa IA para lugares informales ("mi cuarto", "la alberca", etc.)

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

// Catálogo (igual que antes)
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
function _simRatio(a, b) {
  const A = _norm(a), B = _norm(b);
  if (!A && !B) return 1;
  if (!A || !B) return 0;
  const maxLen = Math.max(A.length, B.length);
  let dist = 0;
  for (let i = 0; i < maxLen; i++) {
    if (A[i] !== B[i]) dist++;
  }
  return maxLen ? (1 - dist / maxLen) : 0;
}

/**
 * Distancia de Levenshtein (edición)
 */
function levenshtein(a, b) {
  const an = a.length;
  const bn = b.length;
  if (an === 0) return bn;
  if (bn === 0) return an;

  const matrix = Array(bn + 1).fill(null).map(() => Array(an + 1).fill(null));

  for (let i = 0; i <= an; i++) matrix[0][i] = i;
  for (let j = 0; j <= bn; j++) matrix[j][0] = j;

  for (let j = 1; j <= bn; j++) {
    for (let i = 1; i <= an; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,       // inserción
        matrix[j - 1][i] + 1,       // eliminación
        matrix[j - 1][i - 1] + cost // sustitución
      );
    }
  }

  return matrix[bn][an];
}

/**
 * Similitud basada en Levenshtein (0-1)
 */
function levenshteinSimilarity(a, b) {
  const A = _norm(a), B = _norm(b);
  if (!A && !B) return 1;
  if (!A || !B) return 0;
  const maxLen = Math.max(A.length, B.length);
  const dist = levenshtein(A, B);
  return 1 - (dist / maxLen);
}

/**
 * Busca lugares similares con fuzzy matching
 * Retorna candidatos con similitud >= minSimilarity
 */
function _fuzzySearch(text, { minSimilarity = 0.7, maxResults = 5 } = {}) {
  const N = _norm(text);
  if (!N || N.length < 3) return [];

  const results = [];
  const seen = new Set();

  for (const { term, item } of _phraseIndex) {
    // Evitar duplicados del mismo lugar
    if (seen.has(item.label)) continue;

    // Solo comparar términos de longitud similar
    if (Math.abs(term.length - N.length) > 3) continue;

    const sim = levenshteinSimilarity(N, term);
    if (sim >= minSimilarity) {
      seen.add(item.label);
      results.push({
        item,
        term,
        similarity: sim,
        via: 'fuzzy',
        score: Math.round(sim * 100)
      });
    }
  }

  // Ordenar por similitud descendente
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, maxResults);
}

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

// ✅ NUEVO: helpers para boundaries robustos
function _escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function _isBoundaryChar(ch) {
  // En _norm ya solo hay letras/números/espacios,
  // pero igual lo dejamos genérico.
  return !ch || ch === ' ';
}

// ✅ Parche: evitar matches dentro de palabras (Spa dentro de space)
function _scanPhrases(text, { maxCandidates = 10 } = {}) {
  const N = _norm(text);

  // ✅ Filtrar palabras genéricas sin contexto
  const genericWords = ['habitacion', 'cuarto', 'lugar', 'sitio', 'area'];
  if (genericWords.some(w => N === w)) {
    if (DEBUG) console.log('[PLACE] skip generic word without context:', N);
    return [];
  }

  const hitsMap = new Map(); // Deduplicar por label

  for (const { term, item } of _phraseIndex) {
    // Buscamos ocurrencias; si un término puede repetirse, iteramos.
    // Esto también ayuda a que boundary check sea correcto.
    let startIndex = 0;
    while (true) {
      const idx = N.indexOf(term, startIndex);
      if (idx === -1) break;

      const before = idx > 0 ? N[idx - 1] : '';
      const after = idx + term.length < N.length ? N[idx + term.length] : '';

      // ✅ Regla clave:
      // - Para términos cortos (<=4), exigir que sea palabra completa (boundary a ambos lados)
      //   Ej: "spa" NO debe hacer match en "space"
      // - Para términos largos, permitimos substring (sirve para frases)
      if (term.length <= 4) {
        const okBefore = _isBoundaryChar(before);
        const okAfter = _isBoundaryChar(after);
        if (!okBefore || !okAfter) {
          startIndex = idx + term.length;
          continue;
        }
      }

      const score = term.length;
      const label = item.label;

      if (!hitsMap.has(label) || hitsMap.get(label).score < score) {
        hitsMap.set(label, { item, via: 'phrase', term, score });
      }

      startIndex = idx + term.length;
    }
  }

  const hits = Array.from(hitsMap.values());
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, maxCandidates);
}

// ✅ NUEVO: IA para mapear lugares informales
function placeAISchema() {
  return {
    name: 'Vicebot_Place_Informal_v1',
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
  const system = `Eres un asistente de un hotel que interpreta lugares mencionados de forma informal.

LUGARES DEL CATÁLOGO (ejemplos):
- Habitaciones: "Habitación 1311", "Habitación 5102"
- Torres: "Torre A", "Torre Principal"
- Villas: "Villa 1", "Villa 12"
- Oficinas: "Front Desk", "Oficina Mantenimiento", "HSKP"
- Zonas: "Casero", "Cielomar", "Spa", "Kids Club"

TAREA:
El usuario dijo algo como "mi cuarto", "la alberca", "el lobby". Debes:
1. Si hay número de habitación (4 dígitos) → úsalo
2. Si dice "mi cuarto"/"mi habitación" → inferir número si lo menciona
3. Si dice "lobby"/"recepción" → "Front Desk"
4. Si dice "alberca"/"piscina" → buscar en candidatos
5. Si no sabes → found=false

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

/**
 * ✅ API PRINCIPAL (mejorada)
 */
async function detectPlace(text, opts = {}) {
  const {
    preferRoomsFirst = true, // (se mantiene por compat)
    useAI = true,
    aiModel = DEFAULT_AI_MODEL,
    debugReturn = true
  } = opts;

  const raw = (text || '').toString();
  if (DEBUG) console.log('[PLACE] detect.start', { text: raw });

  // 1) Números de habitación (prioridad máxima)
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

  // 2) Frases del catálogo
  let phraseHits = _scanPhrases(raw);
  let candidates = phraseHits;

  // 3) Si no hay coincidencias directas Y hay IA → probar IA informal
  if (!candidates.length && useAI) {
    const aiRes = await _aiInformalPlace({ text: raw, candidates: [], model: aiModel });
    if (aiRes?.found && aiRes.canonical_label) {
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

  // 4) Si hay 1 candidato fuerte → retornar
  if (candidates.length === 1) {
    const c = candidates[0];
    const it = c.item;
    const meta = {
      building: it.building || it.tower || null,
      floor: it.floor || null,
      room: it.room_number || null
    };
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

  // 5) Si no hay match, intentar fuzzy matching
  if (!candidates.length) {
    const fuzzyResults = _fuzzySearch(raw, { minSimilarity: 0.75, maxResults: 3 });

    if (fuzzyResults.length > 0) {
      if (fuzzyResults[0].similarity >= 0.90) {
        const c = fuzzyResults[0];
        const it = c.item;
        const meta = {
          building: it.building || it.tower || null,
          floor: it.floor || null,
          room: it.room_number || null
        };
        if (DEBUG) console.log('[PLACE] fuzzy.auto_accept', {
          input: raw,
          match: it.label,
          similarity: Math.round(c.similarity * 100) + '%'
        });
        return {
          found: true,
          label: it.label,
          via: 'fuzzy',
          score: c.score,
          meta,
          candidates: debugReturn ? fuzzyResults.map(k => ({
            label: k.item.label,
            via: 'fuzzy',
            score: k.score,
            similarity: Math.round(k.similarity * 100) + '%'
          })) : undefined,
          ai: { used: false },
          fuzzyMatch: true
        };
      }

      if (DEBUG) console.log('[PLACE] fuzzy.suggestions', {
        input: raw,
        suggestions: fuzzyResults.map(r => `${r.item.label} (${Math.round(r.similarity * 100)}%)`)
      });
      return {
        found: false,
        reason: 'fuzzy_suggestions',
        suggestions: fuzzyResults.map(k => ({
          label: k.item.label,
          similarity: Math.round(k.similarity * 100),
          via: 'fuzzy'
        })),
        candidates: debugReturn ? fuzzyResults.map(k => ({
          label: k.item.label,
          via: 'fuzzy',
          score: k.score
        })) : undefined,
        ai: { used: false }
      };
    }
  }

  // 6) No match
  return {
    found: false,
    reason: candidates.length ? 'ambiguous' : 'no_match',
    candidates: debugReturn ? candidates.map(k => ({ label: k.item.label, via: k.via, score: k.score })) : undefined,
    ai: { used: false }
  };
}

module.exports = {
  loadLocationCatalogIfNeeded,
  detectPlace,
};
