/**
 * Parser de los emails de distribuidor (Rubadub y Triple Vision; DBH con su
 * propio parseDbhEmail, 2026-11-03), compartido
 * entre el tab Pre-order del admin (src/App.jsx) y el worker (lib/listen.ts, la
 * bandeja de escucha), para que los dos lean el mismo email igual. Movido tal
 * cual desde App.jsx el 2026-11-02: sin DOMParser ni nada del navegador, solo
 * regex, asi que corre igual en el edge.
 */
import { claveCatno as rdKey } from './preorder-rechazos.mjs';

export function decodeHtmlEntities(s) {
  if (!s) return '';
  let out = String(s);
  // Multi-pass for double-encoding (e.g. &amp;amp; → &amp; → &)
  for (let i = 0; i < 3; i++) {
    out = out
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/&euro;/g, '€').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
      .replace(/&hellip;/g, '…').replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'")
      .replace(/&ldquo;/g, '"').replace(/&rdquo;/g, '"').replace(/&bdquo;/g, '„');
  }
  return out;
}

// ── RUBADUB EMAIL PARSER (source:rd) ───────────────────────────
// Rubadub sends no manifest and no invoice for pre-sales — the release data
// only exists in the per-release announcement email. This turns a pasted email
// (HTML or plain text) into manifest rows the Pre-order tab already consumes.
// Validated against the real HT001 / AD010 / YORE-011LTD / AD009 emails.
//
// Real structure (verified, NOT the order the fields suggest):
//     <prose>
//     Rubadub World Exclusive
//     Please Pre-Order            ← BEFORE the field block
//     Shipping 24th August        ← BEFORE the field block
//
//     Artist: Hot Towel
//     Title: Warm in Your Office EP
//     Label: Hot Towel Records
//     Cat: HT001
//     Format: 12" w / Full sleeve
//     Price: £8.99
//
//     A1. … Download Zip (https://www.dropbox.com/scl/fo/…)   ← AFTER the block
// So each release owns two windows: the prose BEFORE its field block (ship date
// + pre-order marker) and the text AFTER it up to the next release (Dropbox).

export const RD_MONTHS = ['january','february','march','april','may','june',
                   'july','august','september','october','november','december'];

// Is this paste a DIGEST (a catalogue Rubadub sends out) rather than one or
// more per-release announcements? It decides the default selection, and the
// two must not be told apart by row count: three per-release emails pasted in
// one go are three deliberate picks, while a four-line digest is still a
// catalogue — and that short digest is the dangerous one, because nobody
// double-checks four rows.
//
// There are TWO kinds of digest and they behave differently here:
//   • shipping digest — "these are all shipping to you today / next Monday".
//     Carries full field blocks (a real one runs to 132 of them) and the
//     records are already on their way, so they are NOT pre-orders.
//   • weekly pre-sales round-up — "All Rubadub Pre-sales (Week …)". Carries NO
//     field blocks at all, just one link per release, so it parses to zero
//     rows. It is detected only to explain that in the error message.
export const RD_DIGEST_SHIPPING = /these\s+are\s+all\s+shipping\s+to\s+you|shipping\s+to\s+you\s+(today|next\s+\w+)|New\s+Releases\s+Shipping\s+(This|Next)\s+Week|Imports\s+Shipping\s+Today|Today'?s?\s+New\s+Arrivals/i;
export const RD_DIGEST_PRESALES = /All\s+Rubadub\s+Pre-?sales|WEEKLY\s+ROUND\s*UP/i;

// Normalize pasted HTML into the same shape as Rubadub's plaintext part, so a
// single parser handles both. Anchors become "label (url)" — exactly how the
// plaintext renders them — and images become inline [[IMG:url]] markers, which
// keeps every link and image positioned in the text for window attribution.
export function rdHtmlToText(input) {
  // Ya es texto plano. El Apps Script archiva asi los digests grandes, con
  // saltos CRLF, y el \r colgando al final de "Cat: M052\r" hacia fallar la
  // linea de campo: los digests parseaban a CERO releases.
  if (!/<[a-z!/][^>]*>/i.test(input)) return input.replace(/\r/g, '');
  let s = input.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, ' [[IMG:$1]] ');
  s = s.replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
                (_m, href, label) => `${label.replace(/<[^>]+>/g, '')} (${href}) `);
  s = s.replace(/<br\b[^>]*>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|td|th|li|h[1-6]|table|blockquote)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeHtmlEntities(s);
  s = s.replace(/\r/g, '').replace(/[ \t ]+/g, ' ');
  s = s.replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return s;
}

// Dropbox FOLDER link (not a direct .zip). Mailchimp appends tracking junk that
// in the plaintext part arrives mangled (`&mc_cid` loses its `=`), so cut at the
// marker rather than trying to parse it. dl=1 makes Dropbox zip the folder.
export function rdCleanDropbox(url) {
  if (!url) return '';
  let u = url.split(/&(?:amp;)?mc_cid|&(?:amp;)?mc_eid/)[0];
  u = u.replace(/&(?:amp;)?dl=0/g, '').replace(/&amp;/g, '&').replace(/[).,\s]+$/, '');
  if (!/[?&]dl=1/.test(u)) u += (u.includes('?') ? '&' : '?') + 'dl=1';
  return u;
}

// "Shipping 24th August" → 2026-08-24, rolled to next year when the date would
// otherwise sit far in the past relative to the email. Also tolerates the vague
// forms Rubadub really uses ("late August", "mid September", "NEXT WEEK"),
// which resolve to a nominal day and are flagged approximate — an approximate
// release: tag still beats no date, but the operator must see it.
export function rdShipDate(text, emailDate) {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const roll = (month, day) => {
    let d = new Date(emailDate.getFullYear(), month, day);
    if ((d - emailDate) / 86400000 < -30) d = new Date(emailDate.getFullYear()+1, month, day);
    return d;
  };
  const exact = text.match(/Shipping\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)/i);
  if (exact) {
    const month = RD_MONTHS.indexOf(exact[2].toLowerCase());
    if (month >= 0) return { date: iso(roll(month, parseInt(exact[1], 10))), approx: false };
  }
  const vague = text.match(/Shipping\s+(early|mid|late)\s+([A-Za-z]+)/i);
  if (vague) {
    const month = RD_MONTHS.indexOf(vague[2].toLowerCase());
    if (month >= 0) {
      const day = { early: 5, mid: 15, late: 25 }[vague[1].toLowerCase()];
      return { date: iso(roll(month, day)), approx: true, raw: vague[0] };
    }
  }
  const nextWeek = text.match(/Shipping\s+(NEXT\s+WEEK|TODAY|THIS\s+WEEK)/i);
  if (nextWeek) {
    const d = new Date(emailDate);
    d.setDate(d.getDate() + (/NEXT/i.test(nextWeek[1]) ? 7 : 0));
    return { date: iso(d), approx: true, raw: nextWeek[0] };
  }
  return { date: '', approx: false };
}

// La prosa descriptiva del email, para el Body (HTML) de Shopify. Rubadub la
// pone antes del bloque de campos y la repite ampliada despues; se coge el
// trozo mas largo de los dos y se limpian los restos de plantilla de Mailchimp
// (tracklist, enlaces de descarga, pie de pagina), que no son descripcion.
export function descFromProse(before, after, fields) {
  const limpia = (t) => String(t || '')
    .replace(/\[\[IMG:[^\]]*\]\]/g, ' ')
    .replace(/View this email in your browser[^\n]*/gi, ' ')
    .replace(/Download Zip[^\n]*/gi, ' ')
    .replace(/Click here to see our current stocklist[\s\S]*/i, ' ')
    .replace(/Tracklisting[\s\S]*/i, ' ')
    .replace(/Sales Note[\s\S]*/i, ' ')
    .replace(/Order\s+\S+\s+now[\s\S]*/i, ' ')
    .replace(/unsubscribe from this list[\s\S]*/i, ' ')
    .replace(/You received this email[\s\S]*/i, ' ')
    .replace(/(Rubadub (World Exclusive|Import)|Please\s+Pre-?Order|Shipping[^\n]*)/gi, ' ')
    // Las lineas de campo ya viajan como campos; repetirlas en la descripcion
    // es ruido en la ficha del producto.
    .replace(/^[ \t]*(Artist|Title|Label|Catalog|Cat|Format|Price|Barcode|Genre|Release date)[ \t]*:.*$/gim, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split(/\n\s*\n/).map(x => x.trim()).filter(x => x.length > 60);
  const trozos = [...limpia(before), ...limpia(after)];
  if (!trozos.length) return '';
  // Un parrafo suelto puede ser un titular; la descripcion util suele ser el
  // bloque mas largo. Se conserva hasta un limite razonable para Shopify.
  return trozos.sort((a, b) => b.length - a.length).slice(0, 4).join('\n\n').slice(0, 2400);
}

// Parse one or more pasted distributor emails into Pre-order manifest rows.
// Entiende Rubadub y Triple Vision: se distinguen por el nombre del campo del
// catalogo ("Cat:" vs "Catalog:"), asi que un pegado mixto tambien sale bien.
// fx converts the email's GBP to EUR HERE, so the row handed to the Pre-order
// tab carries dealerPrice in EUR like every other distributor's — the tab's
// pricing (margin → ceil − 0.01) is untouched and W&S/DBH are unaffected.
// Cambio fijo GBP→EUR de Rubadub: UNA constante para el tab (valor por defecto
// del campo) y para la ingesta de la bandeja de escucha, para que no se
// desalineen (2026-11-02).
export const RD_GBP_EUR = 1.17;
export function parseDistributorEmail(raw, { fx = RD_GBP_EUR, emailDate = new Date() } = {}) {
  const text = rdHtmlToText(String(raw || ''));
  const rows = [];
  // Document-level, not per-release. A shipping digest says so ONCE, in the
  // opening line, and that fact belongs to every release it carries: in the
  // real 132-release digest "Hi, these are all shipping to you today" appears
  // exactly once, so a per-release test only ever sees it in row 1 and leaves
  // the other 131 looking like an ambiguous partial paste.
  const digest = RD_DIGEST_SHIPPING.test(text) ? 'shipping' : '';

  // Locate every field block. "Cat:" is the anchor — a block without a cat-no
  // is not a release. Each block spans from its Artist:/first field line to the
  // last consecutive "Key: value" line.
  // Rubadub usa 'Cat:'; Triple Vision 'Catalog:' y ademas trae 'Release date:'
  // y 'Genre:' como campos de verdad, que en Rubadub hay que sacar de la prosa
  // o del ZIP. Un solo escaner de bloques, los dos juegos de nombres.
  const FIELD_LINE = /^[ \t]*(Artist|Title|Label|Catalog|Cat|Format|Price|Barcode|Genre|Release date)[ \t]*:[ \t]*(.*)$/i;
  const lines = text.split('\n');
  const offsets = [];
  let pos = 0;
  for (const ln of lines) { offsets.push(pos); pos += ln.length + 1; }

  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!FIELD_LINE.test(lines[i])) continue;
    let j = i;
    const fields = {};
    while (j < lines.length) {
      const m = lines[j].match(FIELD_LINE);
      if (m) { fields[m[1].toLowerCase().replace(/\s+/g, '')] = m[2].trim(); j++; continue; }
      if (!lines[j].trim() && j + 1 < lines.length && FIELD_LINE.test(lines[j+1])) { j++; continue; }
      break;
    }
    if (fields.cat || fields.catalog) blocks.push({ fields, start: offsets[i], end: offsets[j-1] + lines[j-1].length });
    i = j - 1;
  }

  // Lo que hay ANTES del primer bloque de campos vale para todo el email: un
  // anuncio de dos discos pone "Please pre-order" y "Shipping late September"
  // una sola vez, arriba. Buscarlos solo en la ventana de cada release hacia que
  // los viera el primero y ninguno mas — el segundo entraba sin fecha y sin
  // forthcoming, y sin fecha no hay etiqueta de año, y sin año el escaparate lo
  // da por agotado de verdad en vez de ofrecer la peticion.
  const cabecera = blocks.length ? text.slice(0, blocks[0].start) : '';

  blocks.forEach((b, idx) => {
    const propio = text.slice(idx === 0 ? 0 : blocks[idx-1].end, b.start);
    // La ventana propia manda; la cabecera solo se consulta si esa calla. Asi un
    // release con su propia fecha no hereda la de la cabecera.
    const before = propio;
    const after  = text.slice(b.end, idx === blocks.length-1 ? text.length : blocks[idx+1].start);
    const warnings = [];

    // "Artist:" sometimes carries the whole subject line rather than the artist
    // ("Gradient - Random Layers (Alt Dub) AD010"). Keep the part before " - ".
    let artist = b.fields.artist || '';
    if (artist.includes(' - ')) {
      warnings.push(`Artist traía la línea del asunto ("${artist}") → recortado a "${artist.split(' - ')[0].trim()}"`);
      artist = artist.split(' - ')[0].trim();
    }

    const gbp = parseFloat((b.fields.price || '').replace(/[^\d.]/g, ''));
    if (!gbp) warnings.push('sin Price en el email — quedará al suelo de €9.99');

    // The pre-order marker sits in the prose BEFORE the block. A digest instead
    // says "shipping to you today/next Monday": that stock is already on its
    // way, so it must NOT be tagged forthcoming or the graduation cron strips
    // the tag ~15 min later and it reads as a sync bug.
    const MARCA_PRE = /Please\s+Pre-?Order/i;
    const isPreorder = MARCA_PRE.test(propio) || (idx > 0 && MARCA_PRE.test(cabecera));
    // The digest's opening line covers every release it carries; the
    // per-release windows only get consulted when this is not a digest.
    const shipped    = digest === 'shipping' ||
                       /shipping\s+to\s+you\s+(today|next\s+\w+)/i.test(before) ||
                       /shipping\s+(today|this\s+week)/i.test(before);
    // Absence of BOTH markers is ambiguous, not evidence: it is what a partial
    // copy looks like, since both live in the prose above the field block. Say
    // so — silently dropping `forthcoming` from a real pre-order is the same
    // bug as tagging a shipped record, just from the other side. Inside a
    // digest that ambiguity does not exist, so do not raise it there: it would
    // fire on all but the first row and send the operator hunting for text
    // they never failed to copy.
    if (!isPreorder) {
      warnings.push(
        digest === 'shipping'
          ? 'ya enviándose (viene en un digest de envíos) → no es pre-order, sin tag forthcoming'
          : shipped
            ? 'NO es pre-order (el email dice que ya se envía) → sin tag forthcoming'
            : 'no aparece "Please Pre-Order" NI "shipping to you" → queda SIN tag forthcoming. Si es un pre-order, te faltó copiar el texto de encima del bloque de campos: selecciona el email entero.');
    }

    let ship = rdShipDate(propio, emailDate);
    if (!ship.date && idx > 0) ship = rdShipDate(cabecera, emailDate);
    if (!ship.date) warnings.push('sin fecha de envío reconocible — el tag release: irá vacío');
    else if (ship.approx) warnings.push(`fecha aproximada ("${ship.raw}") → ${ship.date}, revísala`);

    // Dropbox link belongs to the window AFTER the block. Digests carry a
    // Mailchimp click-tracker with the params corrupted in plaintext instead —
    // not recoverable by regex, the operator must use the mailchi.mp archive.
    const dropbox = after.match(/https:\/\/www\.dropbox\.com\/scl\/fo\/[^\s)"'<]+/);
    const zipUrl = dropbox ? rdCleanDropbox(dropbox[0]) : '';
    // Los enlaces del promopack DE ESTE bloque, no los del email entero. En el
    // archivo van tras el tracker de Mailchimp, y un email de varios discos
    // lleva uno por disco justo debajo de su ficha (LOG88 y LOG86, las tres de
    // Phonogramme). Coger todos los del email y quedarse con el primer Dropbox
    // le dio a LOG86 el ZIP de LOG88. Se filtra por la etiqueta, que es fija en
    // el archivo real: "Download Zip" (Rubadub) y "Download promopack" /
    // "Promopack: download" (TV); el resto de la ventana son clips, stocklist y
    // el pie, que en el ultimo bloque tambien cae en `after`.
    const zipLinks = [...after.matchAll(/([^\n()]{0,60})\((https:\/\/[^)\s]+)\)/g)]
      .filter(m => /download\s*(zip|promo)|promopack/i.test(m[1]))
      .map(m => m[2].replace(/&amp;/g, '&'));
    if (!zipUrl) {
      warnings.push(/list-manage\.com\/track\/click/i.test(after)
        ? 'el enlace del ZIP es un redirect de Mailchimp (digest): ábrelo en el archivo mailchi.mp y pega ese HTML'
        : 'sin enlace de Dropbox — descarga el promopack a mano');
    }

    // Portada: la imagen INMEDIATAMENTE ANTERIOR a la ficha del disco, dentro de
    // su propia ventana (entre el bloque anterior y este). Asi van Rubadub y
    // Triple Vision: imagen, Artist/Title/Cat…, tracklist, "Download Zip".
    // Antes se buscaba en before+after y se preferia `_compresseds/` a
    // `images/`: si la portada propia era images/ y la del disco siguiente
    // _compresseds/, se llevaba la del siguiente (UTTU199 con la de UTTU195,
    // M055 con la de M056). Medido sobre el archivo: ninguna portada queda
    // detras de su ficha, asi que mirar solo antes no pierde ninguna.
    // Hosts de portada: Rubadub sirve desde mcusercontent (images/ o
    // _compresseds/; gallery.mailchimp.com es el logo de cabecera, nunca la
    // funda), Triple Vision desde su bucket con el sufijo _front.
    const esPortada = (u) => /mcusercontent\.com\/.*(_compresseds\/|\/images\/)/i.test(u)
                          || /digitaloceanspaces\.com\/.*_front[-.]/i.test(u);
    const coverUrl = [...propio.matchAll(/\[\[IMG:([^\]]+)\]\]/g)].map(m => m[1]).filter(esPortada).pop() || '';

    // ── Triple Vision o Rubadub ───────────────────────────────
    // Se distingue por el nombre del campo del catalogo, no por un parametro:
    // "Catalog:" es de TV y "Cat:" de Rubadub, y asi un pegado mixto tambien
    // sale bien sin que nadie tenga que decir de quien es cada email.
    const esTV = !!b.fields.catalog;

    // TV pone el precio en euros y ya negociado; Rubadub en libras, y ahi si
    // hace falta el FX. En los dos casos lo que sale es dealerPrice en EUR.
    let dealer = null;
    if (esTV) dealer = gbp ? Number(gbp.toFixed(2)) : null;
    else      dealer = gbp ? Number((gbp * fx).toFixed(2)) : null;

    // TV trae la fecha como campo en dd-mm-yyyy; Rubadub en prosa inglesa.
    let release = ship.date;
    if (esTV && b.fields.releasedate) {
      const d = b.fields.releasedate.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
      if (d) release = `${d[3]}-${d[2].padStart(2,'0')}-${d[1].padStart(2,'0')}`;
    }

    // TV no dice "Please Pre-Order": lo que manda es si la fecha de salida
    // sigue por delante. Rubadub si lo dice, y ahi manda el marcador.
    const esFuturo = release ? release > new Date(emailDate.getTime()).toISOString().slice(0,10) : false;
    const forthcoming = esTV ? esFuturo : isPreorder;

    // La descripcion importa para Shopify y cada uno la deja en otro sitio:
    // W&S en el SALESPAPER.pdf del ZIP, TV en un _promotext.txt dentro del ZIP,
    // y Rubadub EN NINGUN SITIO salvo el propio email — 6 de sus 7 promopacks
    // no traen ni txt ni pdf. Asi que aqui se rescata la prosa del email, que
    // es la unica fuente que tiene ese distribuidor.
    // Prosa DE ESTE disco. En un email de varios, la ventana anterior termina
    // con la prosa del disco de arriba y la posterior sigue hasta la portada del
    // de abajo: coger "el trozo mas largo de las dos" desplazaba la descripcion
    // un bloque (medido: 848 de 3.039 nombraban solo al artista de otro disco).
    // Ahora: detras, desde la ficha hasta la portada del disco siguiente; delante,
    // el email entero si trae un solo disco, y si trae varios solo lo que hay
    // entre su portada y su ficha (lo anterior es la entradilla del email).
    const portadaSiguiente = idx < blocks.length - 1
      ? [...after.matchAll(/\[\[IMG:([^\]]+)\]\]/g)].find(m => esPortada(m[1])) : null;
    const prosaDetras = portadaSiguiente ? after.slice(0, portadaSiguiente.index) : after;
    const portadaPropia = [...propio.matchAll(/\[\[IMG:([^\]]+)\]\]/g)].filter(m => esPortada(m[1])).pop();
    const prosaDelante = blocks.length === 1 ? before : (portadaPropia ? propio.slice(portadaPropia.index) : '');
    const prosa = descFromProse(prosaDelante, prosaDetras, b.fields);

    rows.push({
      catno: b.fields.catalog || b.fields.cat,
      artist,
      title: b.fields.title || '',
      label: b.fields.label || '',
      // TV si trae genero como campo; en Rubadub se deja vacio a proposito y lo
      // rellena el SALESPAPER, porque adivinarlo es peor que no ponerlo.
      genre: esTV ? (b.fields.genre || '') : '',
      release,
      dealerPrice: dealer,
      format: b.fields.format || '',
      coverUrl,
      zipUrl,
      source: esTV ? 'tv' : 'rd',
      forthcoming,
      _gbp: esTV ? null : (gbp || null),
      _desc: prosa,
      _zipLinks: zipLinks,      // enlaces "Download Zip" de este bloque (tracker o directos)
      _digest: digest,          // '' | 'shipping' | 'presales'
      _warnings: warnings,
    });
  });

  // Un mismo enlace en bloques de discos DISTINTOS no es de ninguno. Pasa en el
  // texto plano de los digests (BLNK029 y UTTU200 llevan el tracker identico) y
  // bajarlo le daria a uno el ZIP del otro. Se quita de los dos y se dice. El
  // mismo disco listado dos veces (TOMTOM002) no cuenta.
  const dueños = new Map();
  for (const r of rows) for (const u of r._zipLinks) {
    if (!dueños.has(u)) dueños.set(u, new Set());
    dueños.get(u).add(rdKey(r.catno));
  }
  const catnoDe = new Map(rows.map(r => [rdKey(r.catno), r.catno]));
  for (const r of rows) {
    const compartidos = r._zipLinks.filter(u => dueños.get(u).size > 1);
    if (!compartidos.length) continue;
    const propio = rdKey(r.catno);
    r._zipLinks = r._zipLinks.filter(u => dueños.get(u).size === 1);
    r._zipShared = [...new Set(compartidos.flatMap(u => [...dueños.get(u)]))].filter(k => k !== propio).map(k => catnoDe.get(k));
    r._warnings.push(`el enlace del ZIP es el mismo que el de ${r._zipShared.join(', ')} — no se usa, baja este a mano`);
  }

  return rows;
}

// ── DBH (source:dbh) ───────────────────────────────────────────
// Todos los emails de DBH (Out soon, Upcoming, bienvenidas, Newsletter KW..)
// acaban en la misma ficha HTML por disco, generada por su tienda: una etiqueta
// (Coming soon | New this week | New last week | Back in Stock) y una tabla
// Catalog / Title / Artist / Label / Release (ISO) / Tracks / Genres / Format,
// el precio dealer en EUR y el enlace release_zip/<id> (publico, sin sesion,
// el ZIP se genera al pedirlo: no caduca). Medido 2026-11-03 sobre los 103
// emails archivados: 1.240 fichas, ningun disco con dos catnos distintos.
// La prosa de encima (Katalognummer:, "IIL 014", ...) no es fiable para datos;
// solo vale como descripcion, y solo del disco al que nombra.
// forthcoming = "Coming soon": lo demas ya se envia.
const DBH_FICHA = /<table style="width: 100%;margin-top:30px/;
const DBH_CAMPO = /valign="top">(Catalog|Title|Artist|Label|Release|Genres|Format)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
const dbhTexto = h => decodeHtmlEntities(String(h || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export function parseDbhEmail(raw) {
  const html = String(raw || '');
  const [cabeza, ...fichas] = html.split(DBH_FICHA);
  // La prosa: desde el saludo hasta la primera ficha, sin enlaces de pedido/escucha.
  const prosa = decodeHtmlEntities(cabeza.replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, ''))
    .split('\n').map(l => l.trim())
    .filter(l => l && !/^(Hello\b|Direct order:|SoundCloud:|Teaser:|Worldwide exclusive)/i.test(l) && !/^https?:\/\//.test(l));
  const desde = prosa.findIndex(l => /\S/.test(l) && !/^DBH-Music\b|^-->$/.test(l));
  const desc = prosa.slice(Math.max(desde, 0)).filter(l => !/^DBH-Music\b|^-->$/.test(l)).join('\n').slice(0, 2400);
  const claveProsa = rdKey(desc);
  const rows = [];
  for (const f of fichas) {
    const c = {};
    for (const [, k, v] of f.matchAll(DBH_CAMPO)) c[k.toLowerCase()] = dbhTexto(v);
    if (!c.catalog) continue;
    const etiquetas = [...f.matchAll(/<span[^>]*background-color:#[0-9a-f]{6};[^>]*>([\s\S]*?)<\/span>/gi)].map(m => dbhTexto(m[1]));
    const zip = f.match(/https:\/\/dbh-music\.com\/shop\/release_zip\/\d+/)?.[0] || '';
    const precio = f.match(/release_view\/\d+"[^>]*>([\s\S]*?)<\/a>/)?.[1];
    const euros = precio ? Number((dbhTexto(precio).match(/(\d+(?:[.,]\d+)?)\s*€/) || [])[1]?.replace(',', '.')) : NaN;
    const img = decodeHtmlEntities(f.match(/<img src="([^"]+)"/)?.[1] || '');
    const release = /^\d{4}-\d{2}-\d{2}$/.test(c.release || '') ? c.release : '';
    rows.push({
      catno: c.catalog,
      artist: c.artist || '',
      title: c.title || '',
      label: c.label || '',
      // Tal cual ("Techno - Minimal"): lo resuelve genres.mjs, y si no resuelve
      // la fila queda sin genero hasta que alguien lo elija.
      genre: c.genres || '',
      release,
      dealerPrice: Number.isFinite(euros) ? euros : null,
      format: c.format || '',
      // La de 300 px responde 302; a 1000 px sale la imagen.
      coverUrl: /^https:\/\/dbh-music\.com\/public\/script\/img\.php\?/.test(img) ? img.replace(/([?&]size=)\d+x\d+/, '$11000x1000') : '',
      zipUrl: zip,
      source: 'dbh',
      forthcoming: etiquetas.some(e => /^coming soon$/i.test(e)),
      _desc: claveProsa.includes(rdKey(c.catalog)) ? desc : '',
      _zipLinks: zip ? [zip] : [],
      _digest: '',
      _warnings: [],
    });
  }
  return rows;
}

// ── TRIAGE POR ASUNTO ──────────────────────────────────────────
// Del nombre del fichero archivado ({PREFIJO}__{asunto}__{fecha}.html), sin abrir
// el cuerpo. Lo usan el tab (triageEmail) y la bandeja de escucha del worker.
// Un digest es un catalogo, no un anuncio. Se reconoce por el asunto.
export const MAIL_DIGEST = [
  /All-Rubadub-Pre-sales/i, /New-Releases-Shipping/i, /Imports-Shipping-Today/i,
  /Triple-Vision-New-Releases/i, /Wordandsound-Update/i, /Newsletter-KW\d+/i,
  /Label-Special/i, /Represses/i,
];
// Una correccion de un email anterior: mismo disco, otra version. No es material
// nuevo, y en TV ademas significa que la URL del promopack ha cambiado.
export const MAIL_REVISION = /^(ART-UPDATE|UPDATE|Price-correction|Artist-and-release-title-correction|Updated-artwork|New-release-date|RELEASE-DATE-SET|Repress)/i;
// La señal de pedido no vive solo bajo WSORD__/RDORD__: los Fwd/Re de Eduardo al
// distribuidor se archivan con el prefijo del distribuidor. Si se cuentan como
// material duplican el anuncio original. Sin falsos positivos: "Repress-" y
// "Release-" no llevan guion tras "Re".
export const MAIL_ORDER = /^(Fwd|Re)-/;
// Fuentes que llegan como REENVIO de Eduardo (Mother Tongue y Kudos no mandan a
// la direccion archivada: el Apps Script busca sus Fwd desde
// emontagut@houseonly.store). Ahi un "Fwd-" es el anuncio, no un pedido.
export const FUENTES_REENVIO = new Set(['MT', 'KUDOS']);
