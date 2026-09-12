/**
 * El correo del vigia de tiendas (scripts/scout/).
 *
 * El informe lo genera un agente en la maquina de Eduardo, pero la clave de
 * Resend vive aqui y aqui se queda: el script manda el texto, el worker lo
 * convierte en un correo legible y lo envia. Es correo interno —un solo
 * destinatario, el que pide el envio— asi que no lleva baja ni cabeceras de
 * lista: no es marketing, es el informe del lunes.
 */

export interface ScoutMailEnv {
  RESEND_API_KEY: string;
  BOOTSTRAP_AUTH_SECRET: string;
}

const FROM = 'House Only <alerts@houseonly.store>';
const REPLY_TO = 'no-reply@houseonly.store';

const esc = (s: string) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Markdown de andar por casa: lo justo para lo que emite report.mjs —titulos,
 * listas, negrita, `codigo` y bloques cercados—. No pretende ser un parser; un
 * informe que use algo mas raro se vera raro, y eso es visible al instante.
 */
export function markdownACorreo(md: string): string {
  const linea = (t: string) => esc(t)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#c8ff00">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code style="background:#141414;border-radius:2px;padding:1px 4px;font-size:12px">$1</code>');

  const out: string[] = [];
  let enCodigo = false, enLista = false;
  const cerrarLista = () => { if (enLista) { out.push('</ul>'); enLista = false; } };

  for (const l of md.split('\n')) {
    if (l.trim().startsWith('```')) {
      cerrarLista();
      // Un bloque cercado es, casi siempre, un prompt para pegar: se pinta como
      // tal para que se vea de lejos que eso se copia entero.
      out.push(enCodigo ? '</pre>' : '<pre style="background:#0f0f0f;border:1px solid #1e1e1e;border-left:2px solid #c8ff00;border-radius:2px;padding:12px 14px;color:#efefef;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;margin:10px 0">');
      enCodigo = !enCodigo;
      continue;
    }
    if (enCodigo) { out.push(esc(l)); continue; }

    const h = l.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      cerrarLista();
      const n = h[1].length;
      const est = n === 1 ? 'font-size:19px;font-weight:800;letter-spacing:-0.5px;margin:0 0 14px'
        : n === 2 ? 'font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#c8ff00;margin:26px 0 10px'
        : 'font-size:14px;font-weight:700;margin:18px 0 8px';
      out.push(`<div style="${est};color:#efefef">${linea(h[2])}</div>`);
      continue;
    }
    const li = l.match(/^(\s*)[-*]\s+(.*)$/);
    if (li) {
      if (!enLista) { out.push('<ul style="margin:6px 0;padding-left:18px;color:#efefef;font-size:13px;line-height:1.65">'); enLista = true; }
      out.push(`<li style="${li[1].length >= 2 ? 'color:#8a8a8a' : ''}">${linea(li[2])}</li>`);
      continue;
    }
    if (!l.trim()) { cerrarLista(); continue; }
    if (/^---+$/.test(l.trim())) { cerrarLista(); out.push('<div style="border-top:1px solid #1e1e1e;margin:24px 0"></div>'); continue; }
    cerrarLista();
    out.push(`<p style="margin:8px 0;color:#efefef;font-size:13px;line-height:1.65">${linea(l)}</p>`);
  }
  cerrarLista();
  if (enCodigo) out.push('</pre>');

  return `<!doctype html><html><body style="margin:0;background:#080808;font-family:Inter,system-ui,sans-serif">
  <div style="max-width:640px;margin:0 auto;padding:30px 20px">
    ${out.join('\n')}
  </div></body></html>`;
}

const UNA_DIRECCION = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export interface ScoutAdjunto { filename: string; content: string }

/** Tope duro: el correo lo tiene que abrir alguien en el movil un lunes. */
const MAX_ADJUNTOS = 6;
const MAX_BASE64 = 8 * 1024 * 1024;

export async function sendScoutReport(
  env: ScoutMailEnv, to: string, subject: string, markdown: string,
  adjuntos: ScoutAdjunto[] = [],
): Promise<{ ok: true; to: string; attachments: number }> {
  if (!UNA_DIRECCION.test(to)) throw new Error('to must be a single address');

  const limpios = adjuntos
    .filter(a => a && typeof a.filename === 'string' && typeof a.content === 'string')
    .filter(a => /^[\w.-]{1,60}\.(jpg|jpeg|png)$/i.test(a.filename))
    .slice(0, MAX_ADJUNTOS);
  let total = 0;
  const pasan = limpios.filter(a => (total += a.content.length) <= MAX_BASE64);

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: FROM, to, subject, html: markdownACorreo(markdown), reply_to: REPLY_TO,
      ...(pasan.length ? { attachments: pasan } : {}),
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return { ok: true, to, attachments: pasan.length };
}
