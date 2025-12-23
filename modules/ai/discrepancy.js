// modules/ai/discrepancy.js
// Detector de discrepancias entre interpretación por TEXTO vs IMAGEN.

const MIN_CONF = Number(process.env.NI_VISION_DISCREPANCY_MINCONF || '0.10'); // confianza mínima de visión para evaluar
const MIN_SIM  = Number(process.env.NI_VISION_DISCREPANCY_MINSIM  || '0.35'); // similitud mínima aceptable (0..1)

function tokenize(s = '') {
  return String(s || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t && t.length > 2);
}

function overlapScore(a = '', b = '') {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  // % de coincidencia respecto al conjunto más pequeño
  return inter / Math.min(A.size, B.size);
}

// Heurística: inferir área a partir de texto libre
function guessAreaFromText(s = '') {
  const t = String(s || '').toLowerCase();
  if (/(it|sistema|sistemas|soporte|tecnolog|wifi|red|impresora|comput|pantalla|pc|router)/.test(t)) return 'it';
  if (/(mantenimiento|mtto|mantto|plomer|tuber|fuga|gotera|humedad|luz|eléctr|electr|bisagra|cerradura|puerta|carpinter|ac|aire|clima|filtro)/.test(t)) return 'man';
  if (/(hskp|housekeeping|ama|limpieza|camarista|blancos|amenidad|amenidades|lavander)/.test(t)) return 'ama';
  if (/(room\s*service|roomservice|rs|alimento|comida|bebida|bandeja|cocina)/.test(t)) return 'rs';
  if (/(seguridad|seg|guardia|acceso|c[aá]mara|cctv|riesgo|alarma)/.test(t)) return 'seg';
  return null;
}

/**
 * Detecta discrepancia entre interpretaciones texto vs imagen.
 * @param {object} args
 * @param {string} args.textInt
 * @param {string} args.imgInt
 * @param {string|null} args.areaText   it|man|ama|rs|seg|null
 * @param {number} args.imgConf         0..1
 * @returns {{mismatch:boolean, score:number, reason:string, areaFromImg:string|null, sim:number}}
 */
function detect({ textInt, imgInt, areaText = null, imgConf = 0 }) {
  // Si no hay interpretación visual o su confianza es menor al umbral, no avisamos discrepancia
  if (!imgInt || imgConf < MIN_CONF) {
    return { mismatch: false, score: 0, reason: 'vision_low_conf', areaFromImg: null, sim: 1 };
  }

  const sim = overlapScore(textInt || '', imgInt || '');
  const areaFromImg = guessAreaFromText(imgInt || '');
  const areaMismatch = !!(areaFromImg && areaText && areaFromImg !== areaText);

  // Discrepancia si poca coincidencia semántica o área distinta
  const simBad = sim < MIN_SIM;
  const mismatch = simBad || areaMismatch;

  const reasons = [];
  if (simBad) reasons.push('interpretaciones poco parecidas');
  if (areaMismatch) reasons.push(`área textual=${areaText} vs imagen=${areaFromImg}`);

  const score = Number(((1 - sim) + (areaMismatch ? 0.25 : 0)).toFixed(2));

  return { mismatch, score, reason: reasons.join(' | '), areaFromImg, sim };
}

module.exports = { detect, guessAreaFromText, overlapScore };
