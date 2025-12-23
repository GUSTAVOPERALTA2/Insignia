(() => {
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ───────────────────────────────────────────────────────────
  // DOM principales
  // ───────────────────────────────────────────────────────────
  const qInput   = $('#q');
  const areaSel  = $('#area');
  const limitSel = $('#limit');
  const btnRefresh = $('#btnRefresh');
  const tbody    = $('#tbody');
  const emptyBox = $('#empty');
  const lastSync = $('#lastSync');
  const btnPrev  = $('#prev');
  const btnNext  = $('#next');
  const rangeLbl = $('#range');
  const statusChips = $$('.chip');

  // Modal (detalle)
  const overlay  = $('#overlay');
  const btnClose = $('#btnClose');
  const modalMeta = $('#modalMeta');
  const detailBox = $('#detail');
  const eventsList = $('#events');
  const modalTitle = $('#modalTitle');

  // ───────────────────────────────────────────────────────────
  // Estado
  // ───────────────────────────────────────────────────────────
  const state = { q:'', area:'', status:'', limit:50, offset:0 };

  // ───────────────────────────────────────────────────────────
  // Helpers comunes
  // ───────────────────────────────────────────────────────────

  // Actualiza el badge de estado en la fila de la tabla principal
  function updateListStatus(incidentId, nextStatus){
    const tr = document.querySelector(`#tbody tr[data-id="${incidentId}"]`);
    if (!tr) return;
    const estadoTd = tr.children && tr.children[2]; // Columna "Estado"
    if (!estadoTd) return;
    estadoTd.innerHTML = `<span class="badge ${statusClass(nextStatus)}">${statusLabel(nextStatus)}</span>`;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('es-MX', {
      year:'2-digit', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit'
    });
  }
  function escapeHtml(s='') {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  const isImageMime = (m) => typeof m === 'string' && m.toLowerCase().startsWith('image/');

  function setLastSync() {
    lastSync.textContent = `Actualizado: ${new Date().toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
  }

  function buildQuery() {
    const p = new URLSearchParams();
    if (state.q)      p.set('q', state.q);
    if (state.area)   p.set('area', state.area);
    if (state.status) p.set('status', state.status);
    p.set('limit', state.limit);
    p.set('offset', state.offset);
    return p.toString();
  }

  async function fetchIncidents() {
    const res = await fetch(`/api/incidents?${buildQuery()}`);
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  }

  // ───────────────────────────────────────────────────────────
  // Badges de área
  // ───────────────────────────────────────────────────────────
  function areaBadge(code) {
    const c = (code||'').toLowerCase();
    const map = { it:'area-it', man:'area-man', ama:'area-ama', rs:'area-rs', seg:'area-seg' };
    return `<span class="badge ${map[c] || 'area-it'}">${(c||'').toUpperCase() || '—'}</span>`;
  }

  // ───────────────────────────────────────────────────────────
  // ESTATUS: mapa, badge, menú flotante y PATCH
  // ───────────────────────────────────────────────────────────
  const STATUS = {
    open:        { label: 'ABIERTA',     cls: 'status-open' },      // amarillo
    in_progress: { label: 'EN PROCESO',  cls: 'status-progress' },  // turquesa
    canceled:    { label: 'CANCELADA',   cls: 'status-canceled' },  // rojo
    done:        { label: 'TERMINADA',   cls: 'status-done' }       // verde
  };
  const allowedStatus = Object.keys(STATUS);
  const statusLabel = (s) => STATUS[s]?.label || (s ? s.toUpperCase() : '—');
  const statusClass = (s) => STATUS[s]?.cls || 'status-open';

  function statusBadge(s) {
    return `<span class="badge ${statusClass(s)}">${statusLabel(s)}</span>`;
  }

  // PATCH → actualiza estatus en backend
  async function patchStatus(id, status) {
    const res = await fetch(`/api/incidents/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    const data = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(data.error || 'status_update_failed');
    return data; // { ok:true, status, at, from }
  }

  // Menú flotante global (cerrar si hay)
  function closeStatusPicker(){
    const p = document.querySelector('.status-picker');
    if (p) p.remove();
    document.removeEventListener('click', onDocClickStatus, { capture:true });
    window.removeEventListener('resize', closeStatusPicker);
    window.removeEventListener('scroll', closeStatusPicker, true);
  }
  function onDocClickStatus(e){
    const p = document.querySelector('.status-picker');
    const trigger = document.querySelector('#statusPill');
    if (!p) return;
    if (!p.contains(e.target) && e.target !== trigger) closeStatusPicker();
  }

  // Abre el menú flotante en body y lo posiciona bajo la píldora
  function openStatusPicker(triggerEl, incident){
    closeStatusPicker();

    const picker = document.createElement('div');
    picker.className = 'status-picker is-floating';
    picker.innerHTML = `
      <button class="status-option opt-open"     data-status="open">ABIERTA</button>
      <button class="status-option opt-progress" data-status="in_progress">EN PROCESO</button>
      <button class="status-option opt-canceled" data-status="canceled">CANCELADA</button>
      <button class="status-option opt-done"     data-status="done">TERMINADA</button>
    `;
    document.body.appendChild(picker);

    // posicionamiento…
    const r = triggerEl.getBoundingClientRect();
    requestAnimationFrame(() => {
      const w = picker.offsetWidth;
      const h = picker.offsetHeight;
      let left = r.right - w;
      let top  = r.bottom + 10;
      left = Math.max(8, Math.min(left, window.innerWidth  - w - 8));
      top  = Math.max(8, Math.min(top,  window.innerHeight - h - 8));
      picker.style.left = `${left}px`;
      picker.style.top  = `${top}px`;
    });

    // ← marca la opción que corresponde al estado actual
    const current = picker.querySelector(`[data-status="${incident.status}"]`);
    if (current) current.classList.add('is-current');

    picker.querySelectorAll('[data-status]').forEach(btn=>{
      btn.addEventListener('click', async () => {
        const next = btn.dataset.status;
        try{
          await patchStatus(incident.id, next);

          // actualiza píldora + info
          const pill = document.querySelector('#statusPill');
          if (pill){
            pill.className = `status-pill badge ${statusClass(next)}`;
            pill.textContent = statusLabel(next);
          }
          const infoEstado = $('#infoEstado');
          if (infoEstado) infoEstado.textContent = statusLabel(next);
          
          // timeline
          const li = document.createElement('li');
          li.className = 'event';
          li.innerHTML = `
            <div class="when">${fmtDate(new Date().toISOString())}
              <span class="etype">• status_change</span>
            </div>
            <div>Cambio de estado → <strong>${statusLabel(next)}</strong></div>`;
          eventsList.appendChild(li);
          updateListStatus(incident.id, next);
          incident.status = next;
        }catch(err){
          console.error(err);
          alert('No se pudo actualizar el estatus');
        }finally{
          closeStatusPicker();
        }
      });
    });

    document.addEventListener('click', onDocClickStatus, { capture:true });
    window.addEventListener('resize', closeStatusPicker);
    window.addEventListener('scroll', closeStatusPicker, true);
  }


  // Render del botón (píldora) en el header
  function renderStatusPill(current){
    return `<button id="statusPill" type="button" class="status-pill badge ${statusClass(current)}">${statusLabel(current)}</button>`;
  }

  // ───────────────────────────────────────────────────────────
  // Galería (detalle)
  // ───────────────────────────────────────────────────────────
  function renderGallery(attachments = [], { compact = false } = {}) {
    if (!attachments.length) return '';
    const cls = `gallery${compact ? ' gallery--sm' : ''}`;
    const items = attachments.map(a => {
      const url  = a.url || a.href || '';
      const name = a.filename || 'archivo';
      const mime = a.mimetype || '';
      if (url && isImageMime(mime)) {
        const h = compact ? ' style="height:80px"' : '';
        return `
          <a class="thumb" href="${escapeHtml(url)}" target="_blank" rel="noopener">
            <img src="${escapeHtml(url)}" alt="${escapeHtml(name)}"${h} loading="lazy"/>
          </a>`;
      }
      const label = `${escapeHtml(name)}${a.size ? ` · ${Math.round(Number(a.size)/1024)}KB` : ''}`;
      return `<a class="file" href="${escapeHtml(url)}" target="_blank" rel="noopener">${label}</a>`;
    }).join('');
    return `<div class="${cls}">${items}</div>`;
  }

  // ───────────────────────────────────────────────────────────
  // Tabla (listado)
  // ───────────────────────────────────────────────────────────
  function renderRows(rows) {
    if (!rows.length) {
      tbody.innerHTML = '';
      emptyBox.classList.remove('hidden');
      return;
    }
    emptyBox.classList.add('hidden');

    tbody.innerHTML = rows.map(r => `
      <tr data-id="${r.id}" class="row">
        <td>${r.folio || '—'}</td>
        <td>${fmtDate(r.created_at)}</td>
        <td>${statusBadge(r.status)}</td>
        <td>${areaBadge(r.area_destino)}</td>
        <td>${escapeHtml(r.lugar || '—')}</td>
        <td>${escapeHtml(r.descripcion || r.interpretacion || '—')}</td>
      </tr>
    `).join('');

    $$('#tbody tr.row').forEach(tr => {
      tr.addEventListener('click', () => openDetail(tr.dataset.id));
    });
  }

  function updatePager(rowsCount) {
    const hasPrev = state.offset > 0;
    const hasNext = rowsCount >= state.limit;
    btnPrev.disabled = !hasPrev;
    btnNext.disabled = !hasNext;
    const start = state.offset + 1;
    const end   = state.offset + rowsCount;
    rangeLbl.textContent = rowsCount ? `${start}–${end}` : '—';
  }

  async function refresh() {
    try {
      const data = await fetchIncidents();
      const rows = data.items || data.rows || [];
      renderRows(rows);
      updatePager(rows.length);
      setLastSync();
    } catch (e) {
      console.error(e);
      tbody.innerHTML = '';
      emptyBox.classList.remove('hidden');
      emptyBox.textContent = 'Error consultando la API';
    }
  }

  // ───────────────────────────────────────────────────────────
  // Detalle: payloads del timeline y chat
  // ───────────────────────────────────────────────────────────
  function renderEventPayload(ev) {
    const p = ev.payload || {};

    if (ev.event_type === 'comment_text' && p.text) {
      return `<div>${escapeHtml(p.text)}</div>`;
    }
    if (Array.isArray(p.attachments) && p.attachments.length) {
      return renderGallery(p.attachments, { compact:true });
    }
    if (p.url) {
      const meta = [{ url: p.url, filename: p.filename || 'archivo', mimetype: p.mimetype || '', size: p.size }];
      return renderGallery(meta, { compact:true });
    }
    if (ev.event_type === 'comment_media') {
      const info = [p.mimetype, (p.size ? `${Math.round(p.size/1024)}KB` : null)].filter(Boolean).join(' · ');
      return `<div class="muted">Adjunto (${escapeHtml(info)})</div>`;
    }
    if (ev.event_type === 'status_change' && p.to) {
      return `<div>Cambio de estado → <strong>${escapeHtml(p.to)}</strong></div>`;
    }
    if (ev.event_type === 'field_update' && p.field) {
      return `<div>Actualizado <strong>${escapeHtml(p.field)}</strong>: ${escapeHtml(p.from || '—')} → ${escapeHtml(p.to || '—')}</div>`;
    }
    return p && Object.keys(p).length ? `<pre>${escapeHtml(JSON.stringify(p, null, 2))}</pre>` : '';
  }

  function renderCommentBubble(c, mine = false) {
    const text = c.payload?.text || c.text || '';
    return `
      <div class="bubble ${mine ? 'bubble--me' : 'bubble--sys'}">
        <div>${escapeHtml(text)}</div>
        <div class="meta">${fmtDate(c.created_at)}</div>
      </div>
    `;
  }

  // ───────────────────────────────────────────────────────────
  // Abrir detalle
  // ───────────────────────────────────────────────────────────
  async function openDetail(id) {
    try {
      const res = await fetch(`/api/incidents/${id}/full`);
      if (!res.ok) throw new Error('detalle');
      const { incident, events } = await res.json();

      // Header: sólo estatus con botón (píldora)
      modalTitle.textContent = incident.folio || 'Incidencia';
      modalMeta.innerHTML = renderStatusPill(incident.status);

      const reportedBy = incident.origin_name  || incident.reported_by || incident.origin  || incident.chat_id || '—';

      // Cuerpo
      detailBox.innerHTML = `
        <div class="card desc">
          <h4>Descripción</h4>
          <div>${escapeHtml(incident.descripcion || incident.interpretacion || '—')}</div>
        </div>

        <div class="card">
          <h4>Información</h4>
          <div class="kv">
            <div class="label">Lugar</div><div>${escapeHtml(incident.lugar || '—')}</div>
            <div class="label">Estado</div><div id="infoEstado">${statusLabel(incident.status)}</div>
            <div class="label">Área</div><div>${(incident.area_destino || '—').toUpperCase()}</div>
            <div class="label">Reportado por</div><div>${escapeHtml(reportedBy)}</div>
            <div class="label">Creado</div><div>${fmtDate(incident.created_at)}</div>
          </div>
        </div>

        <div class="card card--notes" id="commentsCard">
          <h4>Notas</h4>
          <div id="commentList" class="chat-list"></div>
          <div class="chat-input">
            <input id="commentText" class="chat-text" type="text" placeholder="Escribe una nota…"/>
            <button id="btnSendComment" class="chat-send" aria-label="Enviar" disabled>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            </button>
          </div>
        </div>
      `;

      // Evidencias
      const attachments = Array.isArray(incident.attachments) ? incident.attachments : [];
      detailBox.insertAdjacentHTML(
        'beforeend',
        `<div class="card" style="grid-column:1 / -1">
           <h4>Evidencias</h4>
           ${renderGallery(attachments) || '<div class="muted">— Sin evidencias —</div>'}
         </div>`
      );

      // Comentarios (desde events)
      const commentEvents = (events || []).filter(e => e.event_type === 'comment_text' && e.payload?.text);
      const commentListEl = $('#commentList');
      commentListEl.innerHTML = commentEvents.length
        ? commentEvents.map(e => renderCommentBubble(e, false)).join('')
        : `<div class="muted" style="text-align:center;">— Sin comentarios —</div>`;
      const scrollToBottom = () => { commentListEl.scrollTop = commentListEl.scrollHeight; };
      scrollToBottom();

      // Timeline (todos)
      eventsList.innerHTML = (events || []).length
        ? (events || []).map(ev => `
            <li class="event">
              <div class="when">${fmtDate(ev.created_at)} <span class="etype">• ${escapeHtml(ev.event_type || '')}</span></div>
              ${renderEventPayload(ev)}
            </li>
          `).join('')
        : '<li class="event"><div class="when">—</div></li>';

      // Envío local de comentario (cuando exista endpoint, aquí haces POST)
      const txt = $('#commentText');
      const btnSend = $('#btnSendComment');
      const updateSendState = () => { btnSend.disabled = !txt.value.trim(); };
      txt.addEventListener('input', updateSendState);
      updateSendState();

      const sendLocal = () => {
        const text = txt.value.trim();
        if (!text) return;
        const fake = { created_at: new Date().toISOString(), payload: { text } };
        commentListEl.insertAdjacentHTML('beforeend', renderCommentBubble(fake, true));
        commentListEl.scrollTop = commentListEl.scrollHeight;
        txt.value = '';
        updateSendState();
      };
      btnSend.addEventListener('click', sendLocal);
      txt.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendLocal();
        }
      });

      // Activa el menú flotante al hacer click en la píldora
      const statusPill = $('#statusPill');
      statusPill.addEventListener('click', () => openStatusPicker(statusPill, incident));

      overlay.classList.remove('hidden');
    } catch (e) {
      console.error(e);
      alert('No se pudo cargar el detalle.');
    }
  }

  // ───────────────────────────────────────────────────────────
  // Cerrar modal
  // ───────────────────────────────────────────────────────────
  function closeModal(){
    closeStatusPicker();
    overlay.classList.add('hidden');
  }
  btnClose.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (!overlay.classList.contains('hidden') && e.key === 'Escape') closeStatusPicker();
    if (!overlay.classList.contains('hidden') && e.key === 'Escape') closeModal();
  });

  // ───────────────────────────────────────────────────────────
  // Filtros/listeners del listado
  // ───────────────────────────────────────────────────────────
  btnRefresh.addEventListener('click', () => { state.offset = 0; refresh(); });
  qInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { state.q = qInput.value.trim(); state.offset = 0; refresh(); }
  });
  areaSel.addEventListener('change', () => { state.area = areaSel.value; state.offset = 0; refresh(); });
  limitSel.addEventListener('change', () => { state.limit = Number(limitSel.value) || 50; state.offset = 0; refresh(); });

  statusChips.forEach(ch => {
    ch.addEventListener('click', () => {
      statusChips.forEach(c => c.classList.remove('is-active'));
      ch.classList.add('is-active');
      state.status = ch.dataset.status || '';
      state.offset = 0;
      refresh();
    });
  });

  btnPrev.addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); refresh(); });
  btnNext.addEventListener('click', () => { state.offset += state.limit; refresh(); });

  // Inicial
  refresh();
})();
