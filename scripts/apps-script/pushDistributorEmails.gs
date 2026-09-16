/**
 * pushDistributorEmails.gs — empuja al worker los emails ya archivados en Drive.
 *
 * Va JUNTO a saveDistributorEmails.gs, no lo sustituye: ese sigue guardando los
 * .html en Drive (que es tu archivo legible). Esto solo copia lo que ya hay al
 * KV del worker, para que el Pre-order tab pueda listarlos y leerlos desde
 * cualquier navegador, sin depender de que tengas la carpeta montada.
 *
 * ── INSTALACION ─────────────────────────────────────────────────────────────
 * 1. Abre el proyecto de Apps Script donde vive saveDistributorEmails.gs.
 * 2. Crea un fichero nuevo y pega esto.
 * 3. Configuracion → Propiedades del script, añade:
 *      WORKER_URL     https://houseonly-worker.emontagut.workers.dev
 *      WORKER_SECRET  <el BOOTSTRAP_AUTH_SECRET de produccion>
 *    (En propiedades, NO aqui dentro: asi no acaba en ningun sitio compartido.)
 * 4. Ejecuta pushDistributorEmails() a mano una vez y autoriza los permisos.
 *    Sube todo lo que quepa en ~5 minutos (Apps Script corta a los 6). Si hay
 *    mas, el log dice cuantos quedan: repite hasta "nada nuevo que subir".
 * 5. Activadores → nuevo activador → pushDistributorEmails, diario, sobre las
 *    15:30 (despues del que archiva a Drive).
 *
 * Es idempotente por partida doble: aqui se pregunta al worker que tiene ya, y
 * el worker ademas rechaza duplicados por nombre. Ejecutarla de mas no rompe
 * nada ni gasta escrituras.
 */

var CARPETA = 'Preorders';        // dentro de Houseonly.store
// Antes eran 40 ficheros por ejecucion con un activador diario: menos de lo que
// entra en un dia entre Rubadub, TV y DBH, asi que la cola no se vaciaba nunca.
// Ahora manda el reloj. 5 min deja uno de margen al corte de 6 de Apps Script
// para el listado de Drive y el log final.
var PRESUPUESTO_MS = 5 * 60 * 1000;

function pushDistributorEmails() {
  var inicio = Date.now();
  var props  = PropertiesService.getScriptProperties();
  var url    = props.getProperty('WORKER_URL');
  var secret = props.getProperty('WORKER_SECRET');
  if (!url || !secret) {
    throw new Error('Faltan WORKER_URL / WORKER_SECRET en Propiedades del script.');
  }

  // Que tiene ya el worker
  var res = UrlFetchApp.fetch(url + '?action=emails-list', {
    headers: { Authorization: 'Bearer ' + secret },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('emails-list devolvio ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  }
  var yaEsta = {};
  JSON.parse(res.getContentText()).emails.forEach(function (e) { yaEsta[e.name] = true; });

  // Que hay en Drive
  var carpeta = localizarCarpeta_();
  var it = carpeta.getFiles();
  var pendientes = [];
  while (it.hasNext()) {
    var f = it.next();
    var nombre = f.getName();
    // Solo los .html archivados con el patron del Apps Script. Los .pdf de las
    // confirmaciones se quedan fuera: el tab no los sabe leer todavia.
    if (!/^[A-Z]+__.+__\d{4}-\d{2}-\d{2}(__.*)?\.html$/.test(nombre)) continue;
    if (yaEsta[nombre]) continue;
    pendientes.push(f);
  }

  if (!pendientes.length) {
    Logger.log('nada nuevo que subir — el worker ya tiene los ' + Object.keys(yaEsta).length + ' emails');
    return;
  }

  var subidos = 0, fallidos = 0, vistos = 0;
  for (var i = 0; i < pendientes.length; i++) {
    if (Date.now() - inicio > PRESUPUESTO_MS) break;
    var file = pendientes[i];
    vistos++;
    try {
      var r = UrlFetchApp.fetch(url + '?action=emails-ingest', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + secret },
        payload: JSON.stringify({
          name: file.getName(),
          html: file.getBlob().getDataAsString('UTF-8'),
        }),
        muteHttpExceptions: true,
      });
      if (r.getResponseCode() === 200) { subidos++; }
      else { fallidos++; Logger.log('x ' + file.getName() + ' → ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 120)); }
    } catch (err) {
      fallidos++;
      Logger.log('x ' + file.getName() + ' → ' + err);
    }
    Utilities.sleep(150);   // no atropellar al worker
  }

  var quedan = pendientes.length - vistos;
  Logger.log('subidos ' + subidos + ', fallidos ' + fallidos +
             ', quedan ' + quedan + ' en ' + Math.round((Date.now() - inicio) / 1000) + ' s' +
             (quedan ? ' — vuelve a ejecutarla' : ''));
}

/** Houseonly.store/Preorders, sin depender de IDs que caducan. */
function localizarCarpeta_() {
  var raiz = DriveApp.getFoldersByName('Houseonly.store');
  if (!raiz.hasNext()) throw new Error('No encuentro la carpeta Houseonly.store');
  var sub = raiz.next().getFoldersByName(CARPETA);
  if (!sub.hasNext()) throw new Error('No encuentro Houseonly.store/' + CARPETA);
  return sub.next();
}
