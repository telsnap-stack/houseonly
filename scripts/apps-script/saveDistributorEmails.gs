/**
 * Save Word & Sound + DBH + Triple Vision + Rubadub PRE-ORDER emails as .html
 * files into a Drive folder.
 *
 * SETUP (one time):
 *  1. https://script.google.com  → New project. Paste this whole file in.
 *  2. Run `setup` once (creates the Gmail label, asks permission — approve).
 *  3. Triggers (clock icon) → Add Trigger → function `saveDistributorEmails`,
 *     Time-driven → Day timer → every day.
 *  4. Done. New pre-order emails save as .html into the folder below.
 *
 * Saves only emails it hasn't saved before (Gmail label "saved-to-drive"),
 * so it never duplicates and never misses one. The .html it writes is the raw
 * email HTML body — exactly what the importer's builders parse.
 *
 * CHANGES vs previous version (2026-09-16, tarde):
 *  - FIX: el backfill no llegaba al correo antiguo de Rubadub. Miraba solo
 *    newer_than:30d y como mucho las 300 conversaciones MAS RECIENTES por
 *    distribuidor; Rubadub manda tanto que 300 no pasaban del 17-08. Asi se
 *    quedo fuera, por ejemplo, el anuncio de MEOW01 (24-07), que Find ZIPs daba
 *    como "sin correo". backfillDistributorEmails() recorre ahora el correo por
 *    SEMANAS desde BACKFILL_DESDE hasta hoy, sin tope de 30 dias, con
 *    presupuesto de 5 minutos y reanudando donde lo dejo (Propiedades del
 *    script). Ejecutalo hasta que el log diga "Backfill completo".
 *  - El diario mira 100 conversaciones por fuente en vez de 50.
 *
 * CHANGES vs version of 2026-09-16 (mañana):
 *  - FIX: los digests grandes se archivaban en TEXTO PLANO. Con un HTML de
 *    ~1,1 MB, GmailMessage.getBody() devuelve la parte text/plain y no la
 *    text/html. Medido con "Rubadub New Releases Shipping This Week" del 14-09:
 *    el fichero de Drive mide 227.544 bytes, exactamente la parte text/plain, y
 *    el mensaje SI trae su text/html (1.143.720 bytes, 122 "Cat:"). Afectaba a
 *    17 digests de Rubadub del 17-08 al 14-09: sin portadas ni estructura.
 *    Ahora, si getBody() no trae HTML, se saca la parte text/html del mensaje
 *    en crudo (htmlDelMensaje_). Comprobado byte a byte contra un decodificador
 *    MIME de referencia.
 *  - NEW: repararTextoPlano() — una vez, a mano: reescribe con el HTML las
 *    copias de Drive que se guardaron en texto plano. (El archivo del worker
 *    ya se relleno aparte; esto deja Drive igual que el worker.)
 *
 * CHANGES vs version of 2026-08-22:
 *  - NEW: RD (Rubadub) source — per-release pre-orders + shipping digests,
 *    from distribution@ only. Quotes / payment requests / invoices excluded
 *    on purpose: those belong to the invoice-importer flow, not this archive.
 *  - NEW: `in:anywhere` added to the wrapper query, for ALL sources. Eduardo
 *    deletes distributor emails to Trash quickly; without this, anything
 *    trashed before the daily run was lost to the archive. With it, trashed
 *    mail is captured too, so the "don't delete TV until the script runs"
 *    constraint is gone.
 *
 *  - FIX: the "saved-to-drive" label no longer filters the search (it stays as
 *    a visual marker in Gmail only). Filtering by it skipped whole threads, so
 *    replies arriving after first archive — like Eduardo's order Fwds ("2 of
 *    this please"), which Gmail threads with the original — were never saved.
 *    Dedup is per-message by filename now. Order Fwds ARE part of the archive:
 *    they are the "ordered" signal for the local promopack pipeline.
 *
 * To add a distributor later: add an entry to SOURCES below with its own query.
 */

var FOLDER_ID = '1Sfu8bFdU_EhwevG6F_Pon5Aax6PKIsnP';   // your Preorders folder
var PROCESSED_LABEL = 'saved-to-drive';

// Each source: a filename prefix + a precise Gmail query for its pre-order mail.
// newer_than:30d keeps each run cheap; the label stops re-saving.
var SOURCES = [
  {
    prefix: 'WS',
    // Weekly W&S "Update" newsletter only. Excludes order/invoice mail.
    query: 'from:sales@wordandsound.net subject:Update ' +
           '-subject:invoice -subject:"credit note" -subject:Order'
  },
  {
    prefix: 'DBH',
    // DBH pre-order announcements + newsletter. Excludes receipts & account mail.
    query: 'from:noreply@dbh-music.com ' +
           '(subject:Upcoming OR subject:"Out soon" OR subject:Newsletter) ' +
           '-subject:"has been received" -subject:"has been shipped" ' +
           '-subject:"account data"'
  },
  {
    prefix: 'TV',
    // Triple Vision: weekly "New Releases" digest + per-release pre-order mails
    // (subject is "CATNO - Title - Artist (date)"). Excludes profile/subscription
    // mail. Broader than W&S/DBH by design.
    query: 'from:mailing@triplevision.nl ' +
           '-subject:"Update Profile" -subject:subscription ' +
           '-subject:unsubscribe -subject:preferences'
  },
  {
    prefix: 'RD',
    // Rubadub: per-release pre-orders (Please Pre-Order) + shipping digests.
    // Only distribution@ — the retail mailer (website@) is deliberately NOT
    // archived, per Eduardo. Excludes quotes / payment / invoice mail — that
    // is the invoice-importer flow, not pre-orders. Broad on purpose, like TV:
    // per-release subjects vary per catno, so no fixed subject keyword exists.
    query: 'from:distribution@rubadub.co.uk ' +
           '-subject:Quote -subject:"Request for Payment" ' +
           '-subject:invoice -subject:unsubscribe'
  },
  {
    prefix: 'WSORD',
    // W&S order confirmations — the "ordered" signal for the forthcoming
    // pipeline. Subject pattern: 'WAS Order #NNNNN - Telsnap S.L.: EUR X'.
    // Item list is in the HTML body.
    query: 'from:sales@wordandsound.net subject:"WAS Order"'
  },
  {
    prefix: 'RDORD',
    // Rubadub quotes — the "ordered" signal for RD. The email body is an
    // empty shell; the actual item list lives in the attached PDF, so this
    // source saves attachments too (see saveAttachments below).
    query: 'from:distribution@rubadub.co.uk subject:Quote',
    saveAttachments: true
  }
];

function setup() {
  getFolder_();                 // verify folder access
  getOrCreateLabel_();
  Logger.log('Setup OK. Now add a daily time trigger for saveDistributorEmails.');
}

// Daily entry point (used by the time trigger). Scans the newest 100 threads
// per source from the last 30 days — Rubadub alone sends ~10-15 a day.
function saveDistributorEmails() {
  var folder = getFolder_(), label = getOrCreateLabel_(), totalSaved = 0;
  for (var s = 0; s < SOURCES.length; s++) {
    totalSaved += archivarBusqueda_(folder, label, SOURCES[s],
      '(' + SOURCES[s].query + ') newer_than:30d in:anywhere', 100, null).saved;
  }
  Logger.log('Done. Saved %s new file(s).', totalSaved);
}

// Backfill por semanas, sin tope de 30 dias ni de 300 conversaciones. Empieza en
// BACKFILL_DESDE y llega hasta hoy; guarda por donde va en las Propiedades del
// script y se para a los 5 minutos (Apps Script corta a los 6). Ejecutalo a mano
// hasta que el log diga "Backfill completo". Repetirlo no duplica: cada mensaje
// se deduplica por nombre de fichero.
// Lo que Gmail ya borro de la Papelera (30 dias) no se puede recuperar.
var BACKFILL_DESDE = '2026-01-01';
var BACKFILL_PRESUPUESTO_MS = 5 * 60 * 1000;

function backfillDistributorEmails() {
  var inicio = Date.now();
  var props = PropertiesService.getScriptProperties();
  var folder = getFolder_(), label = getOrCreateLabel_(), totalSaved = 0;
  var semana = props.getProperty('backfill_semana') || BACKFILL_DESDE;   // yyyy-MM-dd
  var hoy = fmtDate_(new Date());

  while (semana <= hoy) {
    var fin = sumaDias_(semana, 7);
    var fuente = Number(props.getProperty('backfill_fuente') || '0');
    for (var s = fuente; s < SOURCES.length; s++) {
      // Tambien antes de cada busqueda: las semanas sin correo no pasan por el
      // bucle de mensajes, pero buscar tambien gasta tiempo.
      if (Date.now() - inicio > BACKFILL_PRESUPUESTO_MS) {
        props.setProperty('backfill_semana', semana);
        props.setProperty('backfill_fuente', String(s));
        Logger.log('Pausa por tiempo antes de %s, semana %s. Guardados %s. Vuelve a ejecutarla.', SOURCES[s].prefix, semana, totalSaved);
        return;
      }
      var q = '(' + SOURCES[s].query + ') after:' + semana.replace(/-/g, '/') +
              ' before:' + fin.replace(/-/g, '/') + ' in:anywhere';
      var r = archivarBusqueda_(folder, label, SOURCES[s], q, 500, inicio);
      totalSaved += r.saved;
      if (r.cortado) {
        // A medias en esta fuente y semana: la proxima vez se repite entera (el
        // dedup por nombre salta lo ya guardado).
        props.setProperty('backfill_semana', semana);
        props.setProperty('backfill_fuente', String(s));
        Logger.log('Pausa por tiempo en %s, semana %s. Guardados %s. Vuelve a ejecutarla.', SOURCES[s].prefix, semana, totalSaved);
        return;
      }
      props.setProperty('backfill_fuente', String(s + 1));
    }
    semana = fin;
    props.setProperty('backfill_semana', semana);
    props.setProperty('backfill_fuente', '0');
    Logger.log('Semana hasta %s hecha. Guardados en esta ejecucion: %s', fin, totalSaved);
  }
  Logger.log('Backfill completo hasta hoy. Guardados en esta ejecucion: %s.', totalSaved);
}

// Para volver a empezar el backfill desde BACKFILL_DESDE.
function reiniciarBackfill() {
  PropertiesService.getScriptProperties().deleteProperty('backfill_semana');
  PropertiesService.getScriptProperties().deleteProperty('backfill_fuente');
  Logger.log('Backfill reiniciado: empezara en %s.', BACKFILL_DESDE);
}

function sumaDias_(isoFecha, dias) {
  var p = isoFecha.split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + dias));
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

// Archiva los mensajes de una busqueda. Devuelve {saved, cortado}: cortado si
// se acabo el presupuesto de tiempo (solo cuando se pasa `inicio`).
function archivarBusqueda_(folder, label, src, query, maxThreads, inicio) {
  var totalSaved = 0;
  // NO -label filter here: the label excludes the whole thread, so a reply
  // arriving AFTER the thread was first archived (e.g. Eduardo's order Fwd,
  // sent hours/days later) would never be saved. Dedup is done per-message
  // by filename instead. in:anywhere → also captures mail already in Trash.
  // GmailApp.search pages in chunks of up to 100; loop until maxThreads.
  var threads = [];
  for (var off = 0; off < maxThreads; off += 100) {
    var page = GmailApp.search(query, off, Math.min(100, maxThreads - off));
    threads = threads.concat(page);
    if (page.length < Math.min(100, maxThreads - off)) break;
  }
  if (threads.length >= maxThreads) Logger.log('AVISO — %s: la busqueda llego al tope de %s conversaciones; puede faltar correo: %s', src.prefix, maxThreads, query);

  {   // (bloque del bucle de hilos, igual que antes)
    for (var t = 0; t < threads.length; t++) {
      if (inicio != null && Date.now() - inicio > BACKFILL_PRESUPUESTO_MS) return { saved: totalSaved, cortado: true };
      var messages = threads[t].getMessages();
      for (var m = 0; m < messages.length; m++) {
        var msg = messages[m];

        var subject = msg.getSubject() || 'no-subject';
        var date = msg.getDate();

        // Keep the distributor's own naming in the slug (subject already carries
        // catalog/issue numbers like "#1376", "HT001"), prefixed + dated.
        var fileName = src.prefix + '__' + slug_(subject) + '__' + fmtDate_(date) + '.html';

        if (!folder.getFilesByName(fileName).hasNext()) {
          // HTML completo aunque getBody() devuelva texto plano (ver CHANGES).
          // Solo se pide aqui, para no leer el crudo de mensajes ya archivados.
          var cuerpo = htmlDelMensaje_(msg);
          folder.createFile(fileName, cuerpo.html, MimeType.HTML);
          totalSaved++;
          if (cuerpo.via === 'getBody') Logger.log('Saved: %s', fileName);
          else if (cuerpo.via === 'raw') Logger.log('Saved (HTML sacado del crudo, getBody daba texto plano): %s', fileName);
          else Logger.log('AVISO — guardado en TEXTO PLANO, el mensaje no trae HTML: %s', fileName);
        }

        // Sources flagged saveAttachments also archive attachments (e.g. the
        // Rubadub quote PDF, where the email body is empty and the data is
        // in the PDF).
        if (src.saveAttachments) {
          var atts = msg.getAttachments();
          for (var a = 0; a < atts.length; a++) {
            var attName = src.prefix + '__' + slug_(subject) + '__' +
                          fmtDate_(date) + '__' + atts[a].getName();
            if (!folder.getFilesByName(attName).hasNext()) {
              folder.createFile(atts[a].copyBlob().setName(attName));
              totalSaved++;
              Logger.log('Saved attachment: %s', attName);
            }
          }
        }
      }
      threads[t].addLabel(label);                 // marker only (see above)
    }
  }
  return { saved: totalSaved, cortado: false };
}

// One-off: las copias de Drive que se guardaron en texto plano antes de este
// arreglo se reescriben con el HTML del mensaje. Mira 60 dias (los afectados
// van del 17-08 al 14-09). Solo toca ficheros que HOY son texto plano y solo si
// el mensaje trae HTML; lo demas no se toca. Se puede ejecutar mas de una vez.
function repararTextoPlano() {
  var folder = getFolder_();
  var reparados = 0, sinHtml = 0;
  for (var s = 0; s < SOURCES.length; s++) {
    var src = SOURCES[s];
    var threads = GmailApp.search('(' + src.query + ') newer_than:60d in:anywhere', 0, 300);
    for (var t = 0; t < threads.length; t++) {
      var messages = threads[t].getMessages();
      for (var m = 0; m < messages.length; m++) {
        var msg = messages[m];
        var fileName = src.prefix + '__' + slug_(msg.getSubject() || 'no-subject') + '__' + fmtDate_(msg.getDate()) + '.html';
        var it = folder.getFilesByName(fileName);
        if (!it.hasNext()) continue;
        var file = it.next();
        if (pareceHtml_(file.getBlob().getDataAsString('UTF-8'))) continue;
        var cuerpo = htmlDelMensaje_(msg);
        if (cuerpo.via === 'texto-plano') { sinHtml++; Logger.log('Sin HTML en el mensaje, se deja: %s', fileName); continue; }
        file.setContent(cuerpo.html);
        reparados++;
        Logger.log('Reparado (%s): %s', cuerpo.via, fileName);
      }
    }
  }
  Logger.log('Hecho. Reparados %s; sin HTML en el mensaje %s.', reparados, sinHtml);
}

// ---- HTML completo aunque getBody() devuelva texto plano ----
//
// Con los digests grandes de Rubadub (HTML de ~1,1 MB) GmailMessage.getBody()
// devuelve la parte text/plain, no la text/html: los 17 digests del 17-08 al
// 14-09 se archivaron sin imagenes ni estructura (medido: el fichero de Drive
// mide exactamente lo que la parte text/plain del mensaje, 227.544 bytes, y el
// mensaje SI trae su text/html). Por eso, si getBody() no trae HTML, se saca la
// parte text/html del mensaje en crudo.
function htmlDelMensaje_(msg) {
  var body = msg.getBody();
  if (pareceHtml_(body)) return { html: body, via: 'getBody' };
  var crudo = htmlDeMime_(msg.getRawContent());
  if (crudo && pareceHtml_(crudo)) return { html: crudo, via: 'raw' };
  return { html: body, via: 'texto-plano' };   // no se pierde el email, pero se avisa
}

function pareceHtml_(s) {
  return /<(html|body|table|div|p)\b/i.test(String(s || '').slice(0, 20000));
}

// Primera parte text/html de un mensaje RFC 822, decodificada. null si no hay.
function htmlDeMime_(raw) {
  var parte = buscaHtml_(String(raw || ''));
  return parte;
}

function buscaHtml_(entidad) {
  var corte = entidad.search(/\r?\n\r?\n/);
  if (corte < 0) return null;
  var cab = entidad.slice(0, corte).replace(/\r?\n[ \t]+/g, ' ');   // cabeceras plegadas
  var cuerpo = entidad.slice(corte).replace(/^\r?\n\r?\n/, '');
  var ct = (cab.match(/^content-type:\s*([^;\r\n]+)/im) || [, 'text/plain'])[1].trim().toLowerCase();

  if (ct.indexOf('multipart/') === 0) {
    var b = cab.match(/boundary="?([^";\r\n]+)"?/i);
    if (!b) return null;
    var trozos = cuerpo.split('--' + b[1]);
    for (var i = 1; i < trozos.length; i++) {
      var t = trozos[i];
      if (/^--/.test(t)) break;                         // cierre del multipart
      // El salto de linea que precede a "--boundary" es del separador, no de la parte.
      var h = buscaHtml_(t.replace(/^\r?\n/, '').replace(/\r?\n$/, ''));
      if (h) return h;
    }
    return null;
  }
  if (ct !== 'text/html') return null;

  var cte = ((cab.match(/^content-transfer-encoding:\s*([^\r\n]+)/im) || [, ''])[1] || '').trim().toLowerCase();
  var charset = ((cab.match(/charset="?([^";\r\n]+)"?/i) || [, 'UTF-8'])[1] || 'UTF-8').trim();
  var bytes;
  if (cte === 'base64') {
    bytes = Utilities.base64Decode(cuerpo.replace(/[^A-Za-z0-9+\/=]/g, ''));
  } else if (cte === 'quoted-printable') {
    bytes = qpABytes_(cuerpo);
  } else {
    return cuerpo;                                      // 7bit / 8bit: ya es texto
  }
  return Utilities.newBlob(bytes).getDataAsString(charset);
}

// Quoted-printable → bytes (con signo, como los quiere Utilities.newBlob).
function qpABytes_(s) {
  s = s.replace(/=\r?\n/g, '');                         // saltos blandos
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
      var v = parseInt(s.substr(i + 1, 2), 16);
      out.push(v > 127 ? v - 256 : v);
      i += 2;
    } else {
      var code = s.charCodeAt(i);
      out.push(code > 127 ? (code & 0xff) - 256 : code);
    }
  }
  return out;
}

// ---- helpers ----
function getFolder_() {
  return DriveApp.getFolderById(FOLDER_ID);
}
function getOrCreateLabel_() {
  return GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL);
}
function slug_(s) {
  return s.replace(/[^\w\s#&-]/g, '').replace(/\s+/g, '-').slice(0, 70);
}
function fmtDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
