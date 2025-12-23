// modules/dashboard/api.js
const { Router } = require('express');
const path = require('path');

const { ensureReady } = require('../db/incidenceDB');

let sqlite;
try { sqlite = require('better-sqlite3'); } catch { sqlite = null; }

const DB_PATH = process.env.VICEBOT_DB_PATH ||
  path.join(process.cwd(), 'data', 'vicebot.sqlite');

const roDb = () => sqlite(DB_PATH, { readonly: true });
const rwDb = () => sqlite(DB_PATH); // lectura/escritura

// ─────────────────────────────────────────────
// Estado interno (para hook onStatusChange)
// ─────────────────────────────────────────────
let apiOptions = {}; // se setea en attachDashboardApi

// Helpers
const safeParse = (s, def = []) => { try { return s ? JSON.parse(s) : def; } catch { return def; } };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n|0));
const nowISO = () => new Date().toISOString();

const router = Router();

router.get('/health', (_req, res) => res.json({ ok: true }));

// ─────────────────────────────────────────────
// Listado: /api/incidents?limit&offset&status&area&q&sort
// ─────────────────────────────────────────────
router.get('/incidents', (req, res) => {
  try {
    ensureReady();
    if (!sqlite) return res.status(501).json({ error: 'SQLite no disponible' });
    const db = roDb();

    const { limit = 50, offset = 0, status, area, q, sort = 'created_at:desc' } = req.query;

    const where = [];
    const args = {};

    if (status) { where.push('LOWER(status) = LOWER(@status)'); args.status = String(status); }
    if (area)   { where.push('LOWER(area_destino) = LOWER(@area)'); args.area = String(area); }
    if (q) {
      where.push('(descripcion LIKE @q OR interpretacion LIKE @q OR lugar LIKE @q OR folio LIKE @q)');
      args.q = `%${q}%`;
    }

    const [sortFieldRaw, sortDirRaw] = String(sort || '').split(':');
    const allowedSort = new Set(['created_at','updated_at','folio']);
    const sortField = allowedSort.has(sortFieldRaw) ? sortFieldRaw : 'created_at';
    const sortDir = (sortDirRaw || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const W = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    const SQL = `
      SELECT id, folio, created_at, updated_at, status, chat_id,
             descripcion, interpretacion, lugar, area_destino, attachments_json
      FROM incidents
      ${W}
      ORDER BY ${sortField} ${sortDir}
      LIMIT @limit OFFSET @offset
    `;
    const SQL_COUNT = `SELECT COUNT(*) as total FROM incidents ${W}`;

    args.limit  = clamp(Number(limit), 1, 200);
    args.offset = Math.max(0, Number(offset) || 0);

    const total = db.prepare(SQL_COUNT).get(args).total;
    const rows  = db.prepare(SQL).all(args);

    const items = rows.map(r => {
      const atts = safeParse(r.attachments_json, []);
      const first = Array.isArray(atts) && atts.length ? atts[0] : null;
      return {
        id: r.id,
        folio: r.folio,
        created_at: r.created_at,
        updated_at: r.updated_at,
        status: r.status,
        descripcion: r.descripcion,
        interpretacion: r.interpretacion,
        lugar: r.lugar,
        area_destino: r.area_destino,
        attachments_count: Array.isArray(atts) ? atts.length : 0,
        first_attachment_url: first?.url || null,
      };
    });

    const page = Math.floor(args.offset / args.limit) + 1;

    res.json({
      items,
      total,
      page,
      limit: args.limit,
      offset: args.offset,
      // compat con UI vieja:
      rows: items
    });
  } catch (e) {
    console.error('[API] /incidents error', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// Detalle básico: /api/incidents/:id  (id o folio)
// ─────────────────────────────────────────────
router.get('/incidents/:id', (req, res) => {
  try {
    ensureReady();
    if (!sqlite) return res.status(501).json({ error: 'SQLite no disponible' });
    const db = roDb();

    const id = String(req.params.id);
    const row = db.prepare(`SELECT * FROM incidents WHERE id = ? OR folio = ? LIMIT 1`).get(id, id);
    if (!row) return res.status(404).json({ error: 'not_found' });

    row.areas         = safeParse(row.areas_json);
    row.notes         = safeParse(row.notes_json);
    row.vision_tags   = safeParse(row.vision_tags_json);
    row.vision_safety = safeParse(row.vision_safety_json);
    row.attachments   = safeParse(row.attachments_json);
    row.raw_draft     = safeParse(row.raw_draft_json, null);

    res.json({ incident: row });
  } catch (e) {
    console.error('[API] /incidents/:id error', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// Detalle + timeline: /api/incidents/:id/full
// ─────────────────────────────────────────────
router.get('/incidents/:id/full', (req, res) => {
  try {
    ensureReady();
    if (!sqlite) return res.status(501).json({ error: 'SQLite no disponible' });
    const db = roDb();

    const idOrFolio = String(req.params.id);

    const row = db.prepare(`
      SELECT *
      FROM incidents
      WHERE id = ? OR folio = ?
      LIMIT 1
    `).get(idOrFolio, idOrFolio);

    if (!row) return res.status(404).json({ error: 'not_found' });

    const events = db.prepare(`
      SELECT id, incident_id, created_at, event_type, wa_msg_id, payload_json
      FROM incident_events
      WHERE incident_id = ?
      ORDER BY datetime(created_at) ASC
    `).all(row.id).map(ev => ({ ...ev, payload: safeParse(ev.payload_json, {}) }));

    const incident = {
      ...row,
      areas:         safeParse(row.areas_json),
      notes:         safeParse(row.notes_json),
      vision_tags:   safeParse(row.vision_tags_json),
      vision_safety: safeParse(row.vision_safety_json),
      attachments:   safeParse(row.attachments_json),
      raw_draft:     safeParse(row.raw_draft_json, null),
    };

    res.json({ incident, events });
  } catch (e) {
    console.error('[API] /incidents/:id/full error', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// PATCH estatus: /api/incidents/:id/status
// body: { status: "open|in_progress|canceled|done" | "abierta|en_proceso|cancelada|terminada", reason?, note?, by? }
// ─────────────────────────────────────────────
router.patch('/incidents/:id/status', (req, res) => {
  try {
    ensureReady();
    if (!sqlite) return res.status(501).json({ error: 'SQLite no disponible' });
    const db = rwDb();

    const idOrFolio = String(req.params.id);
    const raw = String(req.body?.status || '').trim().toLowerCase();
    if (!raw) return res.status(400).json({ error: 'missing_status' });

    // Normalización español → canonical
    const map = {
      abierta: 'open',
      'en proceso': 'in_progress',
      'en_proceso': 'in_progress',
      enproceso: 'in_progress',
      cancelada: 'canceled',
      terminada: 'done'
    };
    const canonical = ['open','in_progress','canceled','done'].includes(raw)
      ? raw
      : (map[raw] || null);

    if (!canonical) {
      return res.status(400).json({ error: 'invalid_status', allowed: ['open','in_progress','canceled','done'] });
    }

    // Buscar incidente por id o folio
    const row = db.prepare(`
      SELECT id, status
      FROM incidents
      WHERE id = ? OR folio = ?
      LIMIT 1
    `).get(idOrFolio, idOrFolio);

    if (!row) return res.status(404).json({ error: 'not_found' });

    const prev = (row.status || '').toLowerCase();
    const ts = nowISO();

    if (prev === canonical) {
      // Igual respondemos OK y disparamos hook (idempotencia útil si quieres reintentar notificaciones).
      res.json({ ok: true, status: canonical, from: prev, at: ts, unchanged: true });

      // Hook async no bloqueante
      try {
        if (apiOptions && typeof apiOptions.onStatusChange === 'function') {
          const payload = {
            incidentId: row.id,
            newStatus: canonical, // alias
            to: canonical,
            from: prev || null,
            by: req.body?.by || 'dashboard',
            reason: req.body?.reason ?? null,
            note: req.body?.note ?? null,
            at: ts
          };
          setImmediate(() => {
            Promise.resolve(apiOptions.onStatusChange(payload)).catch(err =>
              console.warn('[API] onStatusChange hook error:', err?.message || err)
            );
          });
        }
      } catch (_) {}
      return;
    }

    // Transacción: update + evento
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE incidents
          SET status = @status,
              updated_at = @ts,
              last_msg_at = @ts
        WHERE id = @id
      `).run({ id: row.id, status: canonical, ts });

      db.prepare(`
        INSERT INTO incident_events (id, incident_id, created_at, event_type, wa_msg_id, payload_json)
        VALUES (@id, @incident_id, @created_at, @event_type, @wa_msg_id, @payload_json)
      `).run({
        id: require('crypto').randomUUID(),
        incident_id: row.id,
        created_at: ts,
        event_type: 'status_change',
        wa_msg_id: null,
        payload_json: JSON.stringify({ from: prev || null, to: canonical })
      });
    });
    tx();

    // Respondemos primero…
    res.json({ ok: true, status: canonical, from: prev || null, at: ts });

    // …y luego disparamos el hook sin bloquear
    try {
      if (apiOptions && typeof apiOptions.onStatusChange === 'function') {
        const payload = {
          incidentId: row.id,
          newStatus: canonical, // alias
          to: canonical,
          from: prev || null,
          by: req.body?.by || 'dashboard',
          reason: req.body?.reason ?? null,
          note: req.body?.note ?? null,
          at: ts
        };
        setImmediate(() => {
          Promise.resolve(apiOptions.onStatusChange(payload)).catch(err =>
            console.warn('[API] onStatusChange hook error:', err?.message || err)
          );
        });
      }
    } catch (_) {}

  } catch (e) {
    console.error('[API] PATCH /incidents/:id/status error', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * Monta este router bajo el path base.
 * Firmas soportadas:
 *  - attachDashboardApi(app)                              → basePath '/api'
 *  - attachDashboardApi(app, { onStatusChange, basePath}) → opciones
 *  - attachDashboardApi(app, '/api')                      → compat antiguo
 */
function attachDashboardApi(app, arg = '/api', maybeOpts) {
  let basePath = '/api';
  let opts = {};

  if (typeof arg === 'string') {
    basePath = arg || '/api';
    opts = maybeOpts || {};
  } else if (typeof arg === 'object' && arg) {
    opts = arg;
    basePath = arg.basePath || '/api';
  }

  apiOptions = opts || {};
  app.use(basePath, router);
  return router;
}

module.exports = { attachDashboardApi, router };
