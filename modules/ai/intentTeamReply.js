// modules/ai/intentTeamReply.js
// Clasificador baseline de mensajes del equipo (sin LLM todavía)
// - Determina intención, relevancia y extrae datos útiles (ETA, asignado, bloqueos, subárea, etc.)
// - Listo para enchufar a un LLM luego: sólo habría que reemplazar/combinar la función classify()

const DEFAULTS = {
  STRICT_CONF: 0.70,
  MIN_CONF: 0.50,
  RELEVANCE_WINDOW_MIN: 30,
};

const GENERIC_ACK = /^(ok|okay|sale|va|v[aá]le|listo|hecho|visto|enterado|👍|✅|👌)\b/i;
const MISTYPE = /^([kq]|kk+|q+|:v|:3|jaja|ajaj|xd+|\.)$/i;

const DONE_CLAIM = /\b(listo|resuelto|solucionado|arreglado|qued[oó])\b/i;
const BLOCKER = /\b(no (tengo|tenemos) (llave|acceso|herramienta|material)|sin (llave|acceso)|bloque(ado|o))\b/i;

const ASSIGNMENT = /\b(lo toma|asigno a|asignado a|se lo paso a|se encarga|responsable|encargad[oa])\s+([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑ.]+(?:\s+[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑ.]+)*)/i;

const SUBAREA = /\b(HVAC|electricidad|plomer[ií]a|Aire|AC|calefacci[oó]n|jardiner[ií]a|pintura|carpinter[ií]a|red(es)?|wifi|switch|impresora|HSKP|Mantenimiento|Seguridad|RS)\b/i;

const QUESTION = /\?|\b(d[oó]nde|qu[eé]|cu[aá]l|c[oó]mo|cu[aá]nto|puedes|podr[ií]a[sn]?|me confirmas|nos pasas)\b/i;

// ETA ejemplos: "voy en 10", "en 15 min", "para mañana 14:00", "hoy 18:30", "llego 12:05"
const ETA_IN_MIN = /\b(en|voy en)\s+(\d{1,3})\s*(min|mins|minutos?)\b/i;
const ETA_HHMM = /\b(hoy|mañana|maniana|para hoy|para mañana)\s*(\d{1,2}:\d{2})\b/i;
const ETA_SOLO_HHMM = /\b(\d{1,2}:\d{2})\b/;

// Folio/ID (#123, MAN-0341, FOLIO 7788)
const FOLIO = /(?:#|folio\s*[:\-]?\s*|id\s*[:\-]?\s*)([A-Z]{2,4}-?\d{2,6}|\d{3,8})/i;

function norm(s='') {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
}

function parseETA(text, nowTs = new Date()) {
  const out = { eta_iso: null, eta_minutes: null, raw: null };

  const m1 = text.match(ETA_IN_MIN);
  if (m1) {
    const mins = parseInt(m1[2], 10);
    if (!Number.isNaN(mins)) {
      const dt = new Date(nowTs.getTime() + mins * 60000);
      out.eta_minutes = mins;
      out.eta_iso = dt.toISOString();
      out.raw = m1[0];
      return out;
    }
  }

  const m2 = text.match(ETA_HHMM);
  if (m2) {
    const day = m2[1].toLowerCase().includes('mañana') || m2[1].toLowerCase().includes('maniana') ? 1 : 0;
    const [hh, mm] = m2[2].split(':').map(n => parseInt(n, 10));
    const dt = new Date(nowTs);
    dt.setDate(dt.getDate() + day);
    dt.setHours(hh, mm, 0, 0);
    out.eta_iso = dt.toISOString();
    out.raw = m2[0];
    return out;
  }

  // fallback "12:05" aislado (si tiene sentido futuro cercano)
  const m3 = text.match(ETA_SOLO_HHMM);
  if (m3) {
    const [hh, mm] = m3[1].split(':').map(n => parseInt(n, 10));
    const dt = new Date(nowTs);
    dt.setHours(hh, mm, 0, 0);
    // si ya pasó hoy, asumir mañana
    if (dt.getTime() <= nowTs.getTime()) dt.setDate(dt.getDate() + 1);
    out.eta_iso = dt.toISOString();
    out.raw = m3[0];
    return out;
  }

  return out;
}

// Heurística principal (reglas); si luego usas LLM, puedes:
//  - Combinar: usar LLM y si conf<0.7, aplicar estas reglas como “refuerzo”
//  - Reemplazar: que el LLM produzca el mismo shape de salida
function classify(text, { quotedHasFolio, bodyHasFolio, inAreaGroup } = {}) {
  const t = text || '';
  const n = norm(t).toLowerCase();
  let intent = 'other';
  let conf = 0.55; // baseline mínimo útil
  const extracted = {};

  // ruido primero
  if (GENERIC_ACK.test(t)) {
    intent = 'noise.generic_ack'; conf = 0.80;
    return { intent, confidence: conf, extracted };
  }
  if (MISTYPE.test(t)) {
    intent = 'noise.mistype'; conf = 0.75;
    return { intent, confidence: conf, extracted };
  }

  // done claim
  if (DONE_CLAIM.test(t)) {
    intent = 'status.done_claim'; conf = 0.80;
  }

  // blocker
  if (BLOCKER.test(t)) {
    intent = 'status.blocker'; conf = Math.max(conf, 0.75);
    extracted.blocking_reason = (t.match(BLOCKER) || [])[0] || null;
  }

  // assignment
  const asg = t.match(ASSIGNMENT);
  if (asg) {
    intent = 'feedback.assignment'; conf = Math.max(conf, 0.80);
    extracted.assignee = asg[2].trim();
  }

  // subárea
  const sub = t.match(SUBAREA);
  if (sub) {
    if (intent === 'other') intent = 'feedback.note';
    conf = Math.max(conf, 0.65);
    extracted.subarea = sub[1];
  }

  // ETA
  const eta = parseETA(t);
  if (eta.eta_iso) {
    intent = 'status.eta'; conf = Math.max(conf, 0.80);
    extracted.eta_iso = eta.eta_iso;
    extracted.eta_text = eta.raw;
    if (eta.eta_minutes !== null) extracted.eta_minutes = eta.eta_minutes;
  }

  // pregunta
  if (QUESTION.test(t)) {
    // si ya tenemos otra intención fuerte, mantenla;
    // si no, considerar question
    if (conf < 0.70) {
      intent = 'feedback.question'; conf = Math.max(conf, 0.70);
    }
  }

  // nota genérica si nada más calzó, pero parece contenido técnico
  if (intent === 'other' && /hab|habitaci[oó]n|cuarto|villa|switch|router|minisplit|fuga|goteo|cable|tomacorriente|pintura|plomer/i.test(t)) {
    intent = 'feedback.note'; conf = Math.max(conf, 0.65);
  }

  // relevancia (si hay folio en body o quoted, o viene en grupo de área)
  const hasSignal = !!(quotedHasFolio || bodyHasFolio || inAreaGroup);
  const is_relevant = hasSignal || conf >= DEFAULTS.STRICT_CONF;

  return { intent, confidence: conf, extracted, is_relevant };
}

/**
 * Punto de entrada único.
 * @param {Object} input
 *  - text: string
 *  - linkMeta: { quotedHasFolio:boolean, bodyHasFolio:boolean, folioFromText?:string }
 *  - channelMeta: { inAreaGroup:boolean }
 *  - incidentContext: { id, folio, area, lugar, descripcion } (opcional)
 *  - nowTs: Date
 * @returns {Object} { intent, confidence, is_relevant, linked_incident_id, extracted, normalized_note }
 */
async function interpretTeamReply(input = {}) {
  const {
    text = '',
    linkMeta = {},
    channelMeta = {},
    incidentContext = null,
    nowTs = new Date(),
  } = input;

  const bodyHasFolio = !!(text && FOLIO.test(text));
  const quotedHasFolio = !!linkMeta.quotedHasFolio;
  const folioFromText = bodyHasFolio ? (text.match(FOLIO) || [])[1] : linkMeta.folioFromText || null;

  const { intent, confidence, extracted, is_relevant } = classify(text, {
    quotedHasFolio,
    bodyHasFolio,
    inAreaGroup: !!channelMeta.inAreaGroup,
  });

  // nota “limpia”
  const normalized_note = text.trim().replace(/\s+/g, ' ').slice(0, 1000);

  // a quién ligamos: preferimos el incidente del contexto resuelto por el linker
  const linked_incident_id = incidentContext?.id || null;

  return {
    intent,
    confidence,
    is_relevant,
    linked_incident_id,
    extracted,
    normalized_note,
    folio_from_text: folioFromText || null,
  };
}

module.exports = {
  interpretTeamReply,
  _internals: { parseETA, classify, DEFAULTS },
};
