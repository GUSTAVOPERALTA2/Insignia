// modules/linker/messageIncidentLinker.js
// Vincula un mensaje del equipo con una incidencia por:
// 1) Reply/quoted del post del ticket (preferente)
// 2) Folio/ID detectado en el texto (#123, MAN-0341, FOLIO 7788)
// (Dejamos TODO para fallback por "últimos despachados al grupo")

const FOLIO_RE =
  /(?:#|\bfolio\b|\bid\b)\s*(?:[:\-]|\s+)?\s*([A-Z]{2,4}-?\d{2,6}|\d{3,8})/i;

function extractFolioFromText(text = '') {
  const m = (text || '').match(FOLIO_RE);
  return m ? m[1] : null;
}

async function getQuotedMeta(msg) {
  try {
    if (!msg.hasQuotedMsg) {
      return { quotedHasFolio: false, folioFromQuoted: null, quotedBody: null };
    }
    const quoted = await msg.getQuotedMessage();
    // 👇 algunos tipos de mensaje guardan el texto en caption/title
    const body =
      quoted?.body ||
      quoted?.caption ||
      quoted?.title ||
      '';
    const folio = extractFolioFromText(body);
    return {
      quotedHasFolio: !!folio,
      folioFromQuoted: folio,
      quotedBody: body,
      quotedMsgId: quoted?.id?.id || quoted?.id?._serialized || null
    };
  } catch {
    return { quotedHasFolio: false, folioFromQuoted: null, quotedBody: null };
  }
}

/**
 * Intenta resolver el incidente por reply o por folio en el texto.
 * incidenceDB debe exponer un lookup por folio o id.
 */
async function linkMessageToIncident(msg, incidenceDB) {
  const text = msg.body || '';
  const { quotedHasFolio, folioFromQuoted, quotedMsgId } = await getQuotedMeta(msg);
  const bodyFolio = extractFolioFromText(text);

  // 1) Por reply con folio en el citado
  if (quotedHasFolio && folioFromQuoted) {
    const inc = await safeFindByFolioOrId(incidenceDB, folioFromQuoted);
    if (inc) {
      return {
        incidentId: inc.id,
        via: 'reply_folio',
        linkMeta: { quotedHasFolio: true, bodyHasFolio: !!bodyFolio, folioFromText: bodyFolio, quotedMsgId }
      };
    }
  }

  // 2) Por folio en el propio texto
  if (bodyFolio) {
    const inc = await safeFindByFolioOrId(incidenceDB, bodyFolio);
    if (inc) {
      return {
        incidentId: inc.id,
        via: 'body_folio',
        linkMeta: { quotedHasFolio: false, bodyHasFolio: true, folioFromText: bodyFolio, quotedMsgId: null }
      };
    }
  }

  // 3) Fallback: últimos despachados al grupo dentro de ventana
  return { incidentId: null, via: 'not_found', linkMeta: { quotedHasFolio: false, bodyHasFolio: false } };
}

async function safeFindByFolioOrId(db, token) {
  if (!db) return null;
  // Intentos comunes de lookup en distintos proyectos
  const fns = [
    'findIncidentByFolio',
    'getIncidentByFolio',
    'getIncidentByHumanId',
    'getIncidentById',
    'findIncidentByIdOrFolio',
  ];
  for (const fn of fns) {
    if (typeof db[fn] === 'function') {
      try {
        const r = await db[fn](token);
        if (r) return r;
      } catch {}
    }
  }
  // si token es número grande, quizá sea id
  if (typeof db.getIncidentById === 'function' && /^\d{3,}$/.test(String(token))) {
    try {
      const r = await db.getIncidentById(String(token));
      if (r) return r;
    } catch {}
  }
  return null;
}

module.exports = {
  extractFolioFromText,
  getQuotedMeta,
  linkMessageToIncident,
};
