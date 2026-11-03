// Bookmarklet del tab W&S: baja los ZIP de /release/{ArtId}/assets con la
// sesion de wordandsound.net del navegador y los sube al worker.
//
// Por que asi: W&S va detras del reto JS de Cloudflare, el worker no puede
// entrar (houseonly-worker/.../src/lib/ws-zips.ts). El navegador ya lo ha pasado.
//
// `wsBookmarklet` se serializa con toString(): tiene que ser AUTOCONTENIDA, sin
// nada de fuera de la funcion. Lleva solo un token de trabajo (24 h, solo esos
// ArtId), nunca el secreto de admin: corre en una pagina ajena.

export const WS_CODIGO_PREFIJO = 'HOWS1';

/** Lo que el tab copia y el bookmarklet pide: HOWS1|<worker>|<token>. */
export function codigoTrabajoWs(workerUrl, token) {
  return `${WS_CODIGO_PREFIJO}|${workerUrl.replace(/\/+$/, '')}|${token}`;
}

export function wsBookmarklet() {
  const PAUSA_MS = 1500;
  const MAX_BYTES = 60 * 1024 * 1024;
  const CLAVE = 'hows_job';
  if (!/(^|\.)wordandsound\.net$/.test(location.hostname)) {
    alert('Abre wordandsound.net con la sesión iniciada y pulsa el bookmarklet allí.');
    return;
  }
  if (window.__howsEnMarcha) { alert('Ya hay una descarga en marcha en esta pestaña.'); return; }
  let guardado = '';
  try { guardado = localStorage.getItem(CLAVE) || ''; } catch (e) { /* sin storage: se pega cada vez */ }
  const codigo = (prompt('Código del tab W&S de HOUSE ONLY.\nPega uno nuevo, o Enter para seguir con el último:', guardado) || '').trim();
  const m = codigo.match(/^HOWS1\|(https:\/\/houseonly-worker(?:-staging)?\.emontagut\.workers\.dev)\|([0-9a-f]{64})$/);
  if (!m) { if (codigo) alert('Código no válido. Cópialo otra vez desde el tab W&S.'); return; }
  try { localStorage.setItem(CLAVE, codigo); } catch (e) { /* idem */ }
  const W = m[1] + '/', T = m[2];
  const auth = { Authorization: 'Bearer ' + T };
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;width:340px;max-height:80vh;overflow:auto;'
    + 'background:#111;color:#eee;font:12px/1.5 -apple-system,system-ui,sans-serif;padding:12px 14px;border:1px solid #444;'
    + 'border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.5)';
  document.body.appendChild(panel);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const st = { total: 0, hechos: 0, ok: 0, sin: 0, actual: '', fallos: [], fin: '', entorno: /staging/.test(W) ? 'STAGING' : 'PROD' };
  const pinta = () => {
    panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
      + '<b>W&amp;S → HOUSE ONLY (' + st.entorno + ')</b><button id="hows-x" style="background:none;border:0;color:#aaa;cursor:pointer;font-size:16px">×</button></div>'
      + '<div>' + st.hechos + ' de ' + st.total + ' · ' + st.ok + ' ok · ' + st.sin + ' sin assets · ' + st.fallos.length + ' fallidos</div>'
      + (st.actual ? '<div style="color:#999">→ ' + esc(st.actual) + '</div>' : '')
      + (st.fallos.length ? '<div style="margin-top:6px;color:#ff8080">' + st.fallos.map((f) => esc(f)).join('<br>') + '</div>' : '')
      + (st.fin ? '<div style="margin-top:8px;color:#9f9">' + esc(st.fin) + '</div>' : '');
    const x = panel.querySelector('#hows-x');
    if (x) x.onclick = () => panel.remove();
  };

  const sube = async (it, blob) => {
    for (let intento = 0; intento < 2; intento++) {
      try {
        const r = await fetch(W + '?action=ws-zips-upload&artid=' + it.artId, {
          method: 'POST', headers: { ...auth, 'Content-Type': 'application/zip' }, body: blob,
        });
        if (r.ok) return '';
        const t = await r.text().catch(() => '');
        if (r.status < 500) return 'worker ' + r.status + ' ' + t.slice(0, 80);
      } catch (e) { if (intento) return 'worker: ' + e.message; }
      await dormir(2000);
    }
    return 'worker: fallo al subir';
  };

  window.__howsEnMarcha = true;
  (async () => {
    try {
      st.actual = 'Leyendo el trabajo…'; pinta();
      const r = await fetch(W + '?action=ws-zips-status', { headers: auth });
      if (!r.ok) { st.fin = ''; st.fallos.push('El worker dice ' + r.status + ': código caducado o no válido. Genera otro en el tab W&S.'); st.actual = ''; pinta(); return; }
      const items = (await r.json()).items || [];
      st.total = items.length;
      st.ok = items.filter((i) => i.estado === 'ok').length;
      st.sin = items.filter((i) => i.estado === 'sin_assets').length;
      st.hechos = st.ok + st.sin;
      const pendientes = items.filter((i) => i.estado === 'pendiente');
      for (let k = 0; k < pendientes.length; k++) {
        const it = pendientes[k];
        const nombre = (it.artNo || '?') + ' (' + it.artId + ')';
        st.actual = nombre; pinta();
        if (k) await dormir(PAUSA_MS);
        let fallo = '';
        try {
          const a = await fetch('/release/' + it.artId + '/assets', { credentials: 'include' });
          if (a.status === 404) {
            const n = await fetch(W + '?action=ws-zips-none&artid=' + it.artId, { method: 'POST', headers: auth });
            if (n.ok) st.sin++; else fallo = 'worker ' + n.status + ' al marcar sin assets';
          } else if (!a.ok) {
            fallo = 'W&S ' + a.status;
            if (a.status === 401 || a.status === 403) {
              st.fallos.push(nombre + ': ' + fallo);
              st.fin = 'Parado: W&S no deja descargar (' + a.status + '). ¿Sesión iniciada? Entra y vuelve a pulsar el bookmarklet.';
              break;
            }
          } else {
            const ct = (a.headers.get('content-type') || '').toLowerCase();
            if (a.redirected || ct.includes('text/html')) {
              st.fallos.push(nombre + ': W&S devolvió una página, no un ZIP');
              st.fin = 'Parado: parece que la sesión de W&S ha caducado. Entra y vuelve a pulsar el bookmarklet.';
              break;
            }
            const blob = await a.blob();
            if (blob.size > MAX_BYTES) fallo = 'ZIP de ' + Math.round(blob.size / 1048576) + ' MB (tope 60 MB)';
            else {
              fallo = await sube(it, blob);
              if (!fallo) st.ok++;
            }
          }
        } catch (e) { fallo = 'red: ' + e.message; }
        if (fallo) st.fallos.push(nombre + ': ' + fallo);
        st.hechos = st.ok + st.sin + st.fallos.length;
        pinta();
      }
      st.actual = '';
      if (!st.fin) {
        st.fin = st.fallos.length
          ? 'Terminado con fallos. Vuelve a pulsar el bookmarklet (Enter): solo reintenta lo que falta.'
          : 'Listo. Vuelve al tab W&S y pulsa «Traer ZIPs de W&S».';
      }
      pinta();
    } catch (e) {
      st.actual = ''; st.fallos.push('Error: ' + e.message); pinta();
    } finally {
      window.__howsEnMarcha = false;
    }
  })();
}

/** URL javascript: para arrastrar a la barra de marcadores. */
export function urlBookmarkletWs() {
  return 'javascript:' + encodeURIComponent('(' + wsBookmarklet.toString() + ')()');
}
