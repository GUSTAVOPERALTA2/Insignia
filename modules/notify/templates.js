// Mensajes cortos y consistentes para DM al emisor
const AREA_LABELS = { it:'IT', man:'Mantenimiento', ama:'HSKP', seg:'Seguridad', rs:'Room Service' };

function areaLabel(code){ return AREA_LABELS[String(code||'').toLowerCase()] || String(code||'').toUpperCase() || '—'; }

module.exports = {
  ackStart: ({ folio, area }) =>
    `👷 *${folio}*: ${areaLabel(area)} tomó tu ticket. Empezamos a trabajar.`,
  question: ({ folio, question }) =>
    `🔎 *${folio}*: ${question}\nResponde aquí y lo paso al equipo.`,
  eta: ({ folio, etaText }) =>
    `⏱️ *${folio}*: estimado ${etaText}. Te aviso si cambia.`,
  blocked: ({ folio, reason }) =>
    `🚧 *${folio}*: ${reason}\n¿Reprogramamos o das acceso? Contesta aquí.`,
  reroute: ({ folio, newArea }) =>
    `🔀 *${folio}* se pasó a *${areaLabel(newArea)}*. Te mantengo al tanto.`,
  evidence: ({ folio, note }) =>
    `📎 *${folio}*: el equipo adjuntó evidencia. ${note ? `“${note}”` : ''}`.trim(),
  doneClaim: ({ folio }) =>
    `✅ *${folio}*: el área reporta que quedó resuelto. ¿Confirmas? Responde “sí” o “no”.`,
  closed: ({ folio }) =>
    `🎉 *${folio}* confirmado y cerrado. ¡Gracias!`,
  reopened: ({ folio }) =>
    `🔄 *${folio}* reabierto. Ya avisé al equipo; seguimos.`,
};
