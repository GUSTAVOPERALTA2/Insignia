// Mensajes cortos y consistentes para DM al emisor
const AREA_LABELS = { it:'IT', man:'Mantenimiento', ama:'HSKP', seg:'Seguridad', rs:'Room Service' };

function areaLabel(code){ return AREA_LABELS[String(code||'').toLowerCase()] || String(code||'').toUpperCase() || '—'; }

// Helper para obtener descripción corta (primeras 10 palabras)
function shortDesc(description) {
  if (!description) return '';
  const words = description.trim().split(/\s+/).slice(0, 10);
  const short = words.join(' ');
  return short + (description.split(/\s+/).length > 10 ? '...' : '');
}

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
    `📎 *${folio}*: el equipo adjuntó evidencia. ${note ? `"${note}"` : ''}`.trim(),
  
  doneClaim: ({ folio }) =>
    `✅ *${folio}*: el área reporta que quedó resuelto. ¿Confirmas? Responde "sí" o "no".`,
  
  closed: ({ folio }) =>
    `🎉 *${folio}* confirmado y cerrado. ¡Gracias!`,
  
  reopened: ({ folio }) =>
    `🔄 *${folio}* reabierto. Ya avisé al equipo; seguimos.`,
  
  // ── NUEVOS: Estados desde Dashboard ──
  done: ({ folio, description }) =>
    `🆔 *${folio}* — ${shortDesc(description)}\n\n✅ Completado desde Dashboard`,
  
  inProgress: ({ folio, description }) =>
    `🆔 *${folio}* — ${shortDesc(description)}\n\n🔧 En progreso desde Dashboard`,
  
  canceled: ({ folio, description }) =>
    `🆔 *${folio}* — ${shortDesc(description)}\n\n❌ Cancelado desde Dashboard`,
  
  open: ({ folio, description }) =>
    `🆔 *${folio}* — ${shortDesc(description)}\n\n🔄 Reabierto desde Dashboard`,
};