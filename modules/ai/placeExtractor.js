// modules/ai/placeExtractor.js
// Detección de lugares a partir de texto usando catálogo + heurística + IA opcional.

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

// ---------------- Utils ----------------
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
function _levenshtein(a, b) {
  a = a || ''; b = b || '';
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,     // delete
        dp[i][j - 1] + 1,     // insert
        dp[i - 1][j - 1] + cost // substitute
      );
    }
  }
  return dp[m][n];
}
function _simRatio(a, b) {
  // 1.0 perfecto, 0.0 malo
  const A = _norm(a), B = _norm(b);
  if (!A && !B) return 1;
  if (!A || !B) return 0;
  const dist = _levenshtein(A, B);
  const maxLen = Math.max(A.length, B.length);
  return maxLen ? (1 - dist / maxLen) : 0;
}

// ---------------- Estructuras en memoria ----------------
let _loadedPath = null;
let _catalog = [];           // [{ id,label,aliases, type, tower/building, floor, room_number, ... }]
let _roomsIndex = new Map(); // '5102' -> item
let _phraseIndex = [];       // [{ term, item }, ...] (label + aliases normalizados)
let _stats = { total: 0, nameIndex: 0, aliasPhrases: 0, roomsIndexed: 0 };

// Helpers de indexación
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
    // Habitación por 4 dígitos
    if (item.room_number && _isRoomToken(item.room_number)) {
      _roomsIndex.set(String(item.room_number), item);
      _stats.roomsIndexed++;
    }
    // Frases
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

// ---------------- Carga del catálogo ----------------
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

// ---------------- Búsqueda por catálogo ----------------
function _scanRoomsFirst(text, { preferRoomsFirst = true } = {}) {
  const raw = (text || '').toString();
  const rooms = _extractRooms(raw);
  const matched = rooms.filter(r => _roomsIndex.has(r));
  if (preferRoomsFirst && matched.length) {
    const r = matched[0];
    const item = _roomsIndex.get(r);
    return {
      found: true, via: 'room',
      item, token: r, score: 1.0
    };
  }
  return { found: false, via: 'room', rooms, matched };
}

function _scanPhrases(text, { maxCandidates = 10 } = {}) {
  const N = _norm(text);
  const hits = [];
  for (const { term, item } of _phraseIndex) {
    if (N.includes(term)) {
      // Score por especificidad = longitud del término
      const score = term.length;
      hits.push({ item, via: 'phrase', term, score });
    }
  }
  // Ordenar por score desc
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, maxCandidates);
}

function _scanFuzzy(text, { maxCandidates = 8, minSim = 0.78 } = {}) {
  const N = _norm(text);
  if (!N) return [];
  const tokens = _uniq(N.split(' ').filter(Boolean));

  // Unir tokens en frases útiles y probar similitud con label y aliases
  const hits = [];
  for (const { term, item } of _phraseIndex) {
    const sim = _simRatio(N, term);
    if (sim >= minSim) {
      hits.push({ item, via: 'fuzzy', term, score: sim });
    }
  }
  // Orden por score desc
  hits.sort((a, b) => (b.score - a.score));
  // Dedup por item.id conservando el de mayor score
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const key = h.item.id || h.item.label;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= maxCandidates) break;
  }
  return out;
}

// ---------------- IA de apoyo para desambiguar ----------------
function placeAidSchema() {
  return {
    name: 'Vicebot_Place_Aid_v1',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        decision:   { type: 'string', enum: ['pick','none'] },
        label:      { type: ['string','null'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        rationale:  { type: ['string','null'] },
        suggestion: { type: ['string','null'] } // si "none", puedes proponer una frase breve de lugar
      },
      required: ['decision','label','confidence','rationale','suggestion']
    }
  };
}

function _buildAidMessages({ text, candidates }) {
  const system =
`Eres un asistente que ayuda a seleccionar el *lugar* más probable dentro de un hotel.
El usuario redactó un mensaje y ya tenemos candidatos (lugares canónicos).
Debes ELEGIR UNO de la lista (si alguno encaja) o devolver "none".

Guías:
- Si el texto incluye un número de *habitación* y existe en candidatos, probablemente sea ese.
- Si alguna frase del mensaje coincide semánticamente con un candidato, elígelo.
- Si ningún candidato encaja, responde decision="none" y sugiere una frase breve (ej. "Habitación 1311" o "Front Desk") si el texto lo insinúa.`;

  const user = {
    text,
    candidates: candidates.map((c, i) => ({
      rank: i + 1,
      label: c.item.label,
      via: c.via,
      score: c.score
    }))
  };

  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(user) }
  ];
}

async function _aiAidChoosePlace({ text, candidates, model = DEFAULT_AI_MODEL }) {
  const c = await client();
  if (!c) throw new Error('OpenAI client not available');

  const schema = placeAidSchema();

  const resp = await c.responses.create({
    model,
    input: _buildAidMessages({ text, candidates }),
    temperature: 0.1,
    max_output_tokens: 300,
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
  if (!out) throw new Error('AI returned empty aid output');
  return out;
}

// ---------------- API principal ----------------
/**
 * Detecta un lugar del mensaje usando catálogo y, si es necesario, IA.
 *
 * @param {string} text
 * @param {object} opts
 *  - preferRoomsFirst (bool): por defecto true → número de 4 dígitos manda.
 *  - useAI (bool): true para intentar desambiguar con IA cuando haya empate o no match directo.
 *  - allowFuzzy (bool): true para permitir similitud por Levenshtein cuando no hay coincidencia exacta.
 *  - aiModel (string): modelo a usar para la ayuda IA.
 *  - minPhraseScore (number): umbral mínimo para considerar phrase hits (por longitud).
 *  - fuzzyMinSim (number): umbral de similitud (0..1) para fuzzy.
 *  - debugReturn (bool): incluye candidatos y detalles en la respuesta (para logs).
 *
 * @returns Promise<{
 *   found: boolean,
 *   label?: string,
 *   via?: 'room'|'phrase'|'fuzzy'|'ai',
 *   score?: number,
 *   meta?: { building?: string|null, floor?: string|null, room?: string|null },
 *   candidates?: Array<{ label:string, via:string, score:number }>,
 *   reason?: string|null,
 *   ai?: { used:boolean, decision?:'pick'|'none', confidence?:number, rationale?:string|null, suggestion?:string|null }
 * }>
 */
async function detectPlace(text, opts = {}) {
  const {
    preferRoomsFirst = true,
    useAI = true,
    allowFuzzy = true,
    aiModel = DEFAULT_AI_MODEL,
    minPhraseScore = 6,  // longitud mínima del término para que cuente
    fuzzyMinSim = 0.80,
    debugReturn = true
  } = opts;

  const raw = (text || '').toString();
  if (DEBUG) console.log('[PLACE] detect.start', { text: raw });

  // 1) Rooms primero
  const roomScan = _scanRoomsFirst(raw, { preferRoomsFirst });
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
      reason: null,
      ai: { used: false }
    };
  } else if (DEBUG) {
    if (roomScan.rooms?.length) console.log('[PLACE] rooms.scan', { numbers: roomScan.rooms, matched: roomScan.matched });
  }

  // 2) Frases exactas (inclusión)
  let phraseHits = _scanPhrases(raw, { maxCandidates: 12 });
  // Filtrar por score mínimo
  phraseHits = phraseHits.filter(h => h.score >= minPhraseScore);

  // 3) Fuzzy si no hay hits
  let fuzzyHits = [];
  if (!phraseHits.length && allowFuzzy) {
    fuzzyHits = _scanFuzzy(raw, { maxCandidates: 10, minSim: fuzzyMinSim });
  }

  // Ensamblar candidatos
  let candidates = [...phraseHits, ...fuzzyHits];
  // Dedup por item.id conservando mejor score
  {
    const bestById = new Map();
    for (const c of candidates) {
      const key = c.item.id || c.item.label;
      const prev = bestById.get(key);
      if (!prev || c.score > prev.score) bestById.set(key, c);
    }
    candidates = Array.from(bestById.values());
  }
  // Orden final
  candidates.sort((a, b) => b.score - a.score);

  if (DEBUG) {
    if (candidates.length) {
      console.log('[PLACE] cand.top', candidates.slice(0, 5).map(x => ({
        label: x.item.label, via: x.via, score: Number(x.score).toFixed(2)
      })));
    } else {
      console.log('[PLACE] cand.none');
    }
  }

  // 4) Decidir
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
      reason: null,
      ai: { used: false }
    };
  }

  // 5) Empate/confusión → IA de ayuda si se permite y hay candidatos
  if (useAI && candidates.length >= 2) {
    try {
      const topN = candidates.slice(0, 8);
      const aid = await _aiAidChoosePlace({ text: raw, candidates: topN, model: aiModel });
      if (DEBUG) console.log('[PLACE AI] aid.out', aid);

      if (aid.decision === 'pick' && aid.label) {
        // Encontrar el candidato más parecido al label devuelto por IA
        let best = null;
        for (const c of topN) {
          const sim = _simRatio(aid.label, c.item.label);
          if (!best || sim > best.sim) best = { ...c, sim };
        }
        if (best && best.sim >= 0.90) {
          const it = best.item;
          const meta = {
            building: it.building || it.tower || null,
            floor: it.floor || null,
            room: it.room_number || null
          };
          return {
            found: true,
            label: it.label,
            via: 'ai',
            score: best.score,
            meta,
            candidates: debugReturn ? candidates.map(k => ({ label: k.item.label, via: k.via, score: k.score })) : undefined,
            reason: 'ai_pick',
            ai: { used: true, decision: aid.decision, confidence: aid.confidence, rationale: aid.rationale, suggestion: aid.suggestion }
          };
        }
      }

      // Si la IA no elige, pero sugiere una frase (ej. “Habitación 1311”) podemos intentar mapearla
      if (aid.decision === 'none' && aid.suggestion) {
        const sug = aid.suggestion;
        // ¿Trae habitación?
        const rooms = _extractRooms(sug);
        if (rooms.length) {
          const r = rooms[0];
          const it = _roomsIndex.get(r);
          if (it) {
            return {
              found: true,
              label: it.label,
              via: 'ai',
              score: 1,
              meta: {
                building: it.building || it.tower || null,
                floor: it.floor || null,
                room: it.room_number || r
              },
              candidates: debugReturn ? candidates.map(k => ({ label: k.item.label, via: k.via, score: k.score })) : undefined,
              reason: 'ai_suggest_room',
              ai: { used: true, decision: aid.decision, confidence: aid.confidence, rationale: aid.rationale, suggestion: aid.suggestion }
            };
          }
        }
      }

      // IA no resolvió
      return {
        found: false,
        reason: 'ambiguous',
        candidates: debugReturn ? candidates.map(k => ({ label: k.item.label, via: k.via, score: k.score })) : undefined,
        ai: { used: true, decision: aid.decision, confidence: aid.confidence, rationale: aid.rationale, suggestion: aid.suggestion }
      };
    } catch (e) {
      if (DEBUG) console.warn('[PLACE AI] aid.err', e?.message || e);
      // Caer a resultado no concluyente con lista de candidatos
      return {
        found: false,
        reason: 'aid_error',
        candidates: debugReturn ? candidates.map(k => ({ label: k.item.label, via: k.via, score: k.score })) : undefined,
        ai: { used: true, error: e?.message || String(e) }
      };
    }
  }

  // 6) No hay candidatos o IA apagada → no match
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
