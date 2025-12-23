// modules/ai/incidentText.js
// Extrae la "incidencia" (núcleo) desde un texto, removiendo lugar/área y muletillas.

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';

function normA(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function escapeRx(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function variantsForLugar(label) {
  if (!label) return [];
  const out = new Set();
  const raw = normA(label);

  out.add(label);
  out.add(raw);

  // Habitación ####
  const mRoom = /habitaci[oó]n\s+(\d{4})/i.exec(label);
  if (mRoom) {
    const n = mRoom[1];
    ['habitación', 'habitacion', 'hab', 'h'].forEach(pref => {
      out.add(`${pref} ${n}`);
      out.add(`${pref}.${n}`);
    });
    out.add(n);
  }

  // Villa ##
  const mVilla = /villa\s+(\d{1,2})/i.exec(label);
  if (mVilla) {
    const n = mVilla[1];
    out.add(`villa ${n}`);
    out.add(`v ${n}`);
    out.add(`v${n}`);
    out.add(`villa${n}`);
  }

  // Frases comunes
  [
    'torre principal',
    'edificio principal',
    'front desk',
    'cielomar',
    'lobby',
  ].forEach(v => {
    if (label.toLowerCase().includes(v)) out.add(v);
  });

  return Array.from(out).filter(Boolean);
}

function stripMentions(s) {
  return s
    .replace(/@\d{5,}/g, ' ')   // @2147517…
    .replace(/@\S+/g, ' ');     // @usuario
}

function stripObviousPlaces(s) {
  // Remueve “en (la|el) (villa|habitación|hab|torre) …” genérico
  return s
    .replace(/\ben\s+(la\s+|el\s+)?(villa|habitaci[oó]n|hab|torre)\s+[A-Za-z0-9#.\- ]+/ig, ' ')
    .replace(/\b(frente de|enfrente de|cerca de)\s+[A-Za-z0-9#.\- ]+/ig, ' ');
}

function stripPoliteness(s) {
  return s
    .replace(/\b(por (fa|favor))\b/ig, ' ')
    .replace(/\b(me (ayudas|apoyas|puedes ayudar|pueden apoyar))\b/ig, ' ')
    .replace(/\b(xfa|xfa\.)\b/ig, ' ');
}

function collapse(s) {
  return s.replace(/\s{2,}/g, ' ').trim();
}

function ruleBasedIncident(text, lugarLabel) {
  let out = String(text || '');

  out = stripMentions(out);
  out = stripObviousPlaces(out);
  out = stripPoliteness(out);

  // Si tenemos un lugar canónico, intenta retirar sus variantes
  for (const v of variantsForLugar(lugarLabel)) {
    const rx = new RegExp(`\\b${escapeRx(v)}\\b`, 'ig');
    out = out.replace(rx, ' ');
    // “en <variante>”
    const rx2 = new RegExp(`\\ben\\s+(la\\s+|el\\s+)?${escapeRx(v)}\\b`, 'ig');
    out = out.replace(rx2, ' ');
  }

  // Limpia conectores sueltos
  out = out.replace(/\b(en|a|al|del|de la|de el|la|el)\b\s*$/ig, ' ');
  out = collapse(out);

  // Si quedó vacío, devuelve el original
  return out || String(text || '');
}

/**
 * Extrae la "incidencia" (sin lugar/área).
 * @param {Object} p
 * @param {string} p.text                Texto fuente (del usuario)
 * @param {string} p.lugarLabel          Label canónica del lugar (opcional)
 * @param {string} p.areaCode            Código de área (opcional)
 * @returns {{incident: string, rationale: string}}
 */
async function deriveIncidentText({ text, lugarLabel, areaCode }) {
  // TODO: aquí podrías intentar una llamada IA y si falla, usar la regla
  try {
    // const ai = await aiCall(...); // si tienes un wrapper
    // if (ai?.incident) return { incident: ai.incident, rationale: 'ai' };
  } catch (e) {
    if (DEBUG) console.warn('[incidentText.ai] err', e?.message || e);
  }

  const incident = ruleBasedIncident(text, lugarLabel);
  return { incident, rationale: 'rule-based' };
}

module.exports = { deriveIncidentText };
