import { describe, it, expect } from 'vitest';
import { prosaDeCorreo, cuerpoSinGenerado, parrafoHtml, descripcionDeProducto } from '../src/lib/html-text.mjs';

// Todos los casos salen del archivo real de correos (517 mensajes, medidos el
// 2026-09-17). Los textos estan recortados pero la forma es la del original.
describe('prosaDeCorreo', () => {
  it('no publica la cabecera de un mensaje reenviado, ni las direcciones', () => {
    // Las cabeceras llegan en lineas propias, que es como las deja el cliente de
    // correo y como estan en el archivo. De eso depende que se corten sin
    // llevarse la prosa que va detras.
    const crudo = [
      '---------- Forwarded message ---------',
      'From: Rubadub <distribution@rubadub.co.uk (mailto:distribution@rubadub.co.uk) >',
      'Date: Wed, Aug 19, 2026 at 2:59 AM',
      'Subject: Beste Hira / Loidis - MP10 (Magic Power) MP10',
      'To: <emontagut@telsnap.com (mailto:emontagut@telsnap.com) >',
      'Beste Hira lands on Magic Power and lays down three cuts of minimalist elegance. Comes with a Loidis (Huerco S!) remix.',
    ].join('\n');
    const limpio = prosaDeCorreo(crudo);
    expect(limpio).toBe('Beste Hira lands on Magic Power and lays down three cuts of minimalist elegance. Comes with a Loidis (Huerco S!) remix.');
    expect(limpio).not.toMatch(/@/);
    expect(limpio).not.toMatch(/Forwarded|Subject:|mailto/i);
  });

  it('quita el saludo del mailing y la cabecera del anuncio, repetida o no', () => {
    const crudo = `Hello Eduardo Montagut, OUT SOON ON RAWAX: RV10 - RICARDO VILLALOBOS - `
      + `MONOSTEREO/ KORNFLAKES (12") VINYL ONLY! DBH-Music - OUT SOON ON RAWAX: RV10 - `
      + `RICARDO VILLALOBOS - MONOSTEREO/ KORNFLAKES (12") VINYL ONLY! RAWAX presents the `
      + `10th release by Ricardo Villalobos on his own series.`;
    expect(prosaDeCorreo(crudo))
      .toBe('VINYL ONLY! RAWAX presents the 10th release by Ricardo Villalobos on his own series.');
  });

  it('deja el fichaje del sello y se lleva el del distribuidor', () => {
    expect(prosaDeCorreo('RAWAX welcomes Mad Rey to the artist family! The first release could not be better. A great selection of diverse House genres on one record.'))
      .toMatch(/^RAWAX welcomes Mad Rey to the artist family!/);
    expect(prosaDeCorreo('DBH Music welcomes GIOTTWAX Recordingsl to the distribution family! very excited to present you the next release by Move D who needs no introduction anymore.'))
      .toBe('very excited to present you the next release by Move D who needs no introduction anymore.');
  });

  // El reproductor pinta los cortes desde <script id="tracks">. Repetirlos en la
  // descripcion es justo lo que se quito del generador en septiembre.
  it.each([
    ['con punto y sin espacio', '1.No. 1 2.No. 2 3.No. 3 4.No. 4 5.No. 5 6.No. 6'],
    ['con cero delante',        '01 Crystal Fantasy 02 Tryblennasense 03 Romantic Sway 04 Techno Centric'],
    ['por caras',               'A1. December Blackout 1.4 B1. December Blackout 2.2 B2. December blackout 3'],
  ])('descarta un bloque que solo trae el tracklist (%s)', (_, crudo) => {
    expect(prosaDeCorreo(crudo)).toBe('');
  });

  it('corta el tracklist pegado al final de una reseña de verdad', () => {
    const crudo = 'Known for their standout releases on the iconic German label Perlon, Narcotic '
      + 'Syntax have long crafted a singular blend of minimalism and subtle emotional depth. '
      + 'With this release they open a fresh chapter, pushing their sound into new, vivid spaces. '
      + 'A. A Cordial Punch in the Gut B. The Narconauts (in Post-anaesthesia Recovery)';
    const limpio = prosaDeCorreo(crudo);
    expect(limpio).toMatch(/vivid spaces\.$/);
    expect(limpio).not.toMatch(/Cordial Punch/);
  });

  it('no publica un aviso de precio ni un cambio de fecha', () => {
    expect(prosaDeCorreo('Price correction - CITB019 - Cat In The Bag 019 - Dial-M & Tommy The Cat (18-09-2026)')).toBe('');
    expect(prosaDeCorreo('NEW DATE: VIBEZ93031 - Heavy Weight EP - Unknown Artist (06-11-2026)')).toBe('');
  });

  it('retrocede a la ultima frase cerrada cuando la ventana viene truncada', () => {
    // La ventana del correo se corta por longitud: IT57 terminaba en 'and thei'.
    const crudo = 'Watching them work together, the focus and the dedication afforded to each other '
      + 'was a genuinely inspiring thing to witness. They truly are Alchemical Sisters, and thei';
    expect(prosaDeCorreo(crudo)).toMatch(/inspiring thing to witness\.$/);
  });

  it('devuelve vacio antes que devolver ruido corto', () => {
    expect(prosaDeCorreo('Hello Eduardo Montagut, OUT SOON: MWX02 - Orlando Voorn - Old Soul EP (7")')).toBe('');
    expect(prosaDeCorreo('')).toBe('');
  });
});

describe('cuerpoSinGenerado', () => {
  const viejo = '<p><strong>Tapir Taming Technology EP</strong> by Narcotic Syntax released on Logistic Records (2026).</p>'
    + '<p><strong>Tracklist</strong></p><ol>\n<li>LOG88_1</li>\n<li>LOG88_2</li>\n</ol>'
    + '<p>12" vinyl. Worldwide shipping from House Only.</p>'
    + '<script id="tracks" type="application/json">[{"t":"A"}]</script>';

  it('borra cabecera, tracklist y coletilla, y respeta el reproductor', () => {
    expect(cuerpoSinGenerado(viejo)).toBe('<script id="tracks" type="application/json">[{"t":"A"}]</script>');
  });

  // Este es el motivo de que exista: poner la prosa DELANTE sin borrar dejaba la
  // cabecera generada fuera del principio, y el limpiador de lectura —que solo
  // la reconoce al principio— la publicaba.
  it('escrito y vuelto a leer, devuelve solo la prosa', () => {
    const nuevo = parrafoHtml('Narcotic Syntax & Perlon, together again.') + cuerpoSinGenerado(viejo);
    expect(descripcionDeProducto(nuevo).texto).toBe('Narcotic Syntax & Perlon, together again.');
  });
});
