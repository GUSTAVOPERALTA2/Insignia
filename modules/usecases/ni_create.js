// modules/usecases/ni_create.js
// Crea la incidencia con todos los campos enriquecidos y confirma al usuario.

const db = require('../db/incidenceDB');
const { areaToGroupId } = require('../utils/areaRouting');

function areaLabel(a) {
  return a ? ({it:'IT',man:'Mantenimiento',ama:'HSKP',rs:'Room Service',seg:'Seguridad'}[a] || a.toUpperCase()) : '';
}

module.exports = async function niCreate({ client, message, ai }) {
  const chat = await message.getChat();
  const reporter = message.from;
  const payload = {
    descripcion: ai.descripcion,
    interpretacion: ai.interpretacion || null,
    lugar: ai.lugar || null,
    area_destino: ai.area_destino || null,
    status: 'Pendiente',
    created_at: new Date().toISOString(),
    reporter,
    // enriquecimiento:
    priority: ai.priority || null,
    severity: ai.severity || null,
    due_at: ai.due_at || null,
    tags: Array.isArray(ai.tags) ? ai.tags : [],
    notes: Array.isArray(ai.notes) ? ai.notes : (ai.notes ? [ai.notes] : []),
    building: ai.building || null,
    floor: ai.floor || null,
    room: ai.room || null
  };

  const record = await db.createIncident(payload);

  // Confirmación al usuario
  const extraPri = payload.priority ? `\n• Prioridad: ${payload.priority.toUpperCase()}` : '';
  const extraSev = payload.severity ? `\n• Severidad: ${payload.severity.toUpperCase()}` : '';
  const extraDue = payload.due_at ? `\n• Vence: ${payload.due_at}` : '';
  const extraLocAdv = (payload.building || payload.floor || payload.room)
    ? `\n• Ubicación avanzada:${payload.building?` Edificio ${payload.building}`:''}${payload.floor?` · Piso ${payload.floor}`:''}${payload.room?` · Habitación ${payload.room}`:''}` : '';
  const extraTags = (payload.tags && payload.tags.length) ? `\n• Etiquetas: ${payload.tags.join(', ')}` : '';
  const extraNotes = (payload.notes && payload.notes.length) ? `\n• Notas: ${payload.notes.join(' | ')}` : '';

  await chat.sendMessage(
    `✅ *Incidencia creada* #${record.id}\n` +
    `• *Área:* ${areaLabel(payload.area_destino)}\n` +
    `• *Lugar:* ${payload.lugar || '—'}\n` +
    `• *Descripción:* ${payload.descripcion}${extraPri}${extraSev}${extraDue}${extraLocAdv}${extraTags}${extraNotes}`
  );

  // Reenvío opcional al grupo del área
  const groupId = areaToGroupId(payload.area_destino);
  if (groupId) {
    const to = await client.getChatById(groupId);
    await to.sendMessage(
      `📣 Nueva incidencia #${record.id}\n` +
      `• *Reporta:* ${message._data?.notifyName || reporter}\n` +
      `• *Área:* ${areaLabel(payload.area_destino)}\n` +
      `• *Lugar:* ${payload.lugar || '—'}\n` +
      `• *Descripción:* ${payload.descripcion}`
    );
  }

  return record;
};
