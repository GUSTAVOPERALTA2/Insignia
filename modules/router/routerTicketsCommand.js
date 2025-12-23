// modules/router/routeTicketsCommand.js

const DEBUG = (process.env.VICEBOT_DEBUG || '1') === '1';
const incidenceDB = require('../db/incidenceDB');

function isDM(msg) {
  const id = msg.from || '';
  return !/@g\.us$/.test(id);
}

function parseTicketsArgs(body = '') {
  const parts = body.trim().split(/\s+/);
  // parts[0] = "/tickets"
  const arg = (parts.slice(1).join(' ') || '').toLowerCase().trim();

  if (!arg || arg === 'abiertas' || arg === 'abiertos' || arg === 'pendientes') {
    return { mode: 'open' };
  }
  if (['cerradas', 'cerrados', 'finalizadas', 'terminadas'].includes(arg)) {
    return { mode: 'closed' };
  }
  if (['todas', 'all'].includes(arg)) {
    return { mode: 'all' };
  }
  // fallback: lo tratamos como "open"
  return { mode: 'open' };
}

function statusFilterForMode(mode) {
  switch (mode) {
    case 'open':
      // ajusta a los estados reales de tu status-machine
      return ['open', 'in_progress', 'awaiting_confirmation'];
    case 'closed':
      return ['closed', 'cancelled']; // o como los tengas
    case 'all':
    default:
      return null; // sin filtro de status
  }
}

function formatTicketsList(rows = [], mode) {
  if (!rows.length) {
    return '📋 No encontré tickets con ese filtro para este chat.';
  }

  let title = '📋 Tus tickets';
  if (mode === 'open') title = '📋 Tus tickets abiertos';
  if (mode === 'closed') title = '📋 Tus tickets cerrados';

  const lines = [];
  lines.push(`${title} (${rows.length})`);
  lines.push('');

  rows.forEach((r, idx) => {
    const n = idx + 1;
    const folio = r.folio || r.id || 'SIN-FOLIO';
    const lugar = r.lugar && String(r.lugar).trim() ? String(r.lugar).trim() : 'Sin lugar';
    const rawDesc =
      (r.descripcion && String(r.descripcion).trim()) ||
      (r.interpretacion && String(r.interpretacion).trim()) ||
      '(sin descripción)';
    const desc = rawDesc.length > 90 ? rawDesc.slice(0, 87) + '…' : rawDesc;
    const status = r.status || 'sin_estado';

    lines.push(`${n}. *${folio}* · *${lugar}*`);
    lines.push(`   ${desc} (estado: ${status})`);
    lines.push(''); // línea en blanco entre tickets
  });

  if (rows.length >= 10) {
    lines.push('Mostrando los 10 más recientes.');
  }

  return lines.join('\n');
}

async function handleTicketsCommand(client, msg) {
  if (!isDM(msg)) return false;

  const body = (msg.body || '').trim();
  if (!body.toLowerCase().startsWith('/tickets')) return false;

  const chatId = msg.from;
  const { mode } = parseTicketsArgs(body);
  const statusIn = statusFilterForMode(mode);

  if (DEBUG) {
    console.log('[TICKETS] cmd', { chatId, mode, statusIn });
  }

  let rows = [];
  try {
    rows = await incidenceDB.listIncidentsForChat(chatId, {
      statusIn,
      limit: 10,
    });
  } catch (e) {
    console.error('[TICKETS] db error', e?.message || e);
    await msg.reply('Hubo un problema al consultar tus tickets. Inténtalo más tarde.');
    return true;
  }

  const reply = formatTicketsList(rows, mode);
  await msg.reply(reply);
  return true;
}

module.exports = {
  handleTicketsCommand,
};
