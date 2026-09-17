/**
 * Los generos del catalogo: la unica lista.
 *
 * La usan tres sitios y no puede haber un cuarto que escriba generos por su
 * cuenta: los 8 importers al generar el CSV, la rejilla al construir su
 * desplegable, y el barrido que limpia lo que ya esta en Shopify.
 *
 * JavaScript plano —no TypeScript— porque lo importan Vite (App.jsx) y node a
 * secas (scripts/): un .ts tumba el build de Pages, como paso con html-text.
 *
 * ── POR QUE LOS TAGS SON `genre:algopegado` ──────────────────────────────
 * Shopify TOKENIZA los tags al buscarlos, y esto esta medido contra el
 * catalogo real, no supuesto:
 *
 *   tag:'2-Step'   → 8      tag:'step' → 8     el guion parte igual que el espacio
 *   tag:'house'    → arrastra los "Deep House"
 *   tag:'techno'   → arrastra "Techno - Minimal" y "Techno - Dub"
 *   tag:'deep-house' → 250, o sea que casa con "Deep House"
 *   tag:'release:2026' → 229, o sea que dentro de un prefijo el guion TAMBIEN parte
 *   tag:'label:pampa' → 8   pero  tag:'pampa' → 0   ← el dos puntos NO parte
 *
 * De ahi la forma: prefijo `genre:` —que aisla— y valor PEGADO, sin espacios,
 * guiones, `&`, `+` ni `/`. Cualquier separador reabre el problema.
 */

/**
 * RESOLVER y SER PILDORA son dos cosas distintas.
 *   - Resolver: el importer convierte el valor del distribuidor en genre:<id>.
 *     Todo genero de la lista resuelve desde el dia que entra.
 *   - Pildora: sale en el desplegable de la tienda. Regla: NINGUNA pildora
 *     puede dar cero discos.
 * `pildora: 'con-discos'` marca un genero nuevo cuya pildora solo aparece
 * cuando la seccion tiene al menos un disco con su tag (lo comprueba la tienda
 * con la misma consulta que la rejilla). Sin el campo, la pildora sale siempre:
 * son los generos que ya tienen catalogo.
 *
 * `tipo` de cada alias:
 *   'misma' → dice lo mismo que el canonico, o no dice nada. El barrido lo BORRA.
 *   'sub'   → nombra algo mas concreto y es dato real. Se CONSERVA en el
 *             producto (no entra en el desplegable, pero sigue en la busqueda).
 */
export const GENRES = [
  { id:'drumandbass', label:'Drum & Bass', seccion:'dnb', orden:1, alias:[
    { raw:'dnb', tipo:'misma' }, { raw:'Drum n Bass', tipo:'misma' },
    { raw:'Drum and Bass', tipo:'misma' }, { raw:'Drum & Bass', tipo:'misma' },
    { raw:'Drum + Bass', tipo:'misma' }, { raw:"Jungle / Drum 'n' Bass", tipo:'misma' },
    { raw:'Jungle / Drum n Bass', tipo:'misma' }, { raw:'Jungle / Drum & Bass', tipo:'misma' },
    { raw:'Jungle', tipo:'sub' }, { raw:'Liquid Funk', tipo:'sub' },
    { raw:'Hardcore Drum & Bass', tipo:'sub' },
    // Los 4 discos con `Breaks` del catalogo son jungle de los 90 —Ellis Dee,
    // Mad Dog— y ya resolvian a drum & bass por otro tag. Como 'sub' la palabra
    // se queda y el valor deja de caer en la cola.
    { raw:'Breaks', tipo:'sub' }, { raw:'Break', tipo:'sub' },
  ]},
  // Seccion 'house' = el catalogo principal, no porque sea house: la seccion D&B
  // solo lista genre:drumandbass, asi que en 'dnb' seria una pildora sin discos.
  // Solo el nombre canonico como alias; las grafias que aparezcan pasaran por la
  // cola antes de añadirse.
  //
  // Bass Music va ANTES que Garage a proposito, y eso decide los 7 discos que
  // llevan los dos: el lote de Tempa, Hardline y HFT100 trae `2-Step`,
  // `Dubstep`, `Future Garage` y `Garage` a la vez, y un disco resuelve a UN
  // solo canonico. Medido el 2026-09-17 sobre el catalogo entero: son los
  // unicos 7, mas SIG028RP que solo dice `Dubstep` y ya era drum & bass.
  //
  // `Dubstep` y `2-Step` entran como 'sub': resuelven a Bass Music cuando
  // llegan sueltos, y el tag crudo SE QUEDA en el producto, asi que el buscador
  // los encuentra por esas palabras aunque la pildora diga otra cosa.
  { id:'bassmusic', label:'Bass Music', seccion:'house', orden:7, pildora:'con-discos', alias:[
    { raw:'Bass Music', tipo:'canonico' },
    { raw:'Dubstep', tipo:'sub' }, { raw:'2-Step', tipo:'sub' }, { raw:'2 Step', tipo:'sub' },
    { raw:'Grime', tipo:'sub' }, { raw:'Bassline', tipo:'sub' },
  ]},
  // Garage resuelve desde hoy, pero su pildora no se pinta hasta que haya un
  // disco que diga Garage SIN decir Dubstep: los 7 que existen se los lleva
  // Bass Music por prioridad. `pildora:'con-discos'` es justo lo que evita que
  // salga un desplegable con una entrada a cero.
  { id:'garage', label:'Garage', seccion:'house', orden:8, pildora:'con-discos', alias:[
    { raw:'Garage', tipo:'canonico' }, { raw:'UK Garage', tipo:'misma' },
    { raw:'Future Garage', tipo:'sub' }, { raw:'Speed Garage', tipo:'sub' },
  ]},
  { id:'deephouse', label:'Deep House', seccion:'house', orden:2, padre:'house', alias:[
    { raw:'Deep House', tipo:'canonico' }, { raw:'Deephouse', tipo:'misma' },
  ]},
  { id:'techhouse', label:'Tech House', seccion:'house', orden:4, padre:'house', alias:[
    { raw:'Tech House', tipo:'canonico' }, { raw:'Techhouse', tipo:'misma' },
  ]},
  { id:'brokenbeat', label:'Broken Beat', seccion:'house', orden:6, alias:[
    { raw:'Broken Beat', tipo:'canonico' }, { raw:'Broken', tipo:'misma' },
  ]},
  { id:'electro', label:'Electro', seccion:'house', orden:5, alias:[
    { raw:'Electro', tipo:'canonico' },
  ]},
  { id:'techno', label:'Techno', seccion:'house', orden:3, alias:[
    { raw:'Techno', tipo:'canonico' },
    { raw:'Techno - Minimal', tipo:'sub' }, { raw:'Techno - Dub', tipo:'sub' },
    { raw:'Techno - Broken', tipo:'sub' }, { raw:'Detroit Techno', tipo:'sub' },
    { raw:'Minimal', tipo:'sub' },
  ]},
  // El mas general va el ULTIMO: un disco con "Deep House" y "House" es deep house.
  { id:'house', label:'House', seccion:'house', orden:1, alias:[
    { raw:'House', tipo:'canonico' },
    { raw:'Detroit House', tipo:'sub' }, { raw:'Acid House', tipo:'sub' },
    { raw:'Chicago House', tipo:'sub' }, { raw:'Disco House', tipo:'sub' },
    { raw:'Afro House', tipo:'sub' }, { raw:'Soulful House', tipo:'sub' },
  ]},

  // ── LO QUE NO ES CLUB ──────────────────────────────────────────────
  //
  // Estos tres van DESPUES de `house`, o sea los ultimos de la prioridad, y eso
  // es la pieza importante: un disco que dice "Jazz" y "House" es house, como
  // siempre; solo se los llevan los discos que no dicen nada mas.
  //
  // Existen porque 99 discos activos no tenian NI UN genero —medido el
  // 2026-09-17— y por tanto no se llegaba a ellos por ningun filtro de la
  // tienda. No son sobras: son los discos que se traen a proposito aunque no
  // encajen con el resto del catalogo. 57 de esos 99 caen en estos tres.
  //
  // Casi todos los alias son 'sub' —se CONSERVAN en el producto— porque aqui la
  // palabra concreta es informacion de verdad: quien busca "boogie" quiere los
  // de boogie, no los 22 del grupo entero.
  { id:'electronica', label:'Electronica', seccion:'house', orden:9, pildora:'con-discos', alias:[
    { raw:'Electronica', tipo:'canonico' }, { raw:'Electronica/Dance', tipo:'misma' },
    { raw:'Ambient', tipo:'sub' }, { raw:'IDM', tipo:'sub' },
    { raw:'Modern Classical Music', tipo:'sub' }, { raw:'Modern Classical', tipo:'sub' },
    // `Electronic` lo escribe Word and Sound en 136 discos y 133 ya tienen
    // genero propio: en una tienda de electronica no distingue nada. Va aqui,
    // el ultimo de todo, para que solo se lleve los que no dicen nada mas, y
    // como 'sub' para que el tag crudo no se borre de esos 136.
    { raw:'Electronic', tipo:'sub' },
  ]},
  { id:'soulfunkdisco', label:'Soul · Funk · Disco', seccion:'house', orden:10, pildora:'con-discos', alias:[
    { raw:'Soul', tipo:'sub' }, { raw:'Funk', tipo:'sub' }, { raw:'Disco', tipo:'sub' },
    { raw:'Boogie', tipo:'sub' }, { raw:'RnB', tipo:'sub' }, { raw:'R&B', tipo:'sub' },
    { raw:'Soul/R&B', tipo:'sub' },
  ]},
  { id:'jazz', label:'Jazz', seccion:'house', orden:11, pildora:'con-discos', alias:[
    { raw:'Jazz', tipo:'canonico' },
    { raw:'Nu Jazz', tipo:'sub' }, { raw:'Spiritual Jazz', tipo:'sub' },
    { raw:'Fusion', tipo:'sub' },
    // Erratas vistas en la cola: dicen lo mismo, no aportan nada, se borran.
    { raw:'Jazz Eletronic', tipo:'misma' }, { raw:'Jazz Electronic', tipo:'misma' },
  ]},
];

/**
 * Valores que aparecen como genero en el catalogo y NO lo son: nombres de
 * artista, colores, restos cortados. No van al desplegable, no son alias de
 * nadie, y el barrido los borra. Que esten aqui por nombre —y no por una regla
 * lista— es a proposito: una regla automatica volveria a colar basura nueva.
 */
export const NO_SON_GENEROS = ['Dark D', 'blue', 'Brazil', 'Reissue', 'Carl Craig', 'Eclectic', 'Folk', 'Headz', 'Patchwork'];

/**
 * Tags que hablan del PRENSADO, no de la musica: color del vinilo, tirada,
 * edicion. No son generos y tampoco son basura —dicen algo del disco— asi que
 * ni resuelven genero, ni se borran, ni ensucian la cola de revision.
 */
export const RUIDO_DE_PRENSADO = ['limited', 'collectors edition', 'colored', 'orange', 'red', 'clear', 'W/Lbl', '200 copies', '10'];

export const genreTag = id => `genre:${id}`;

/**
 * Los tags de un genero Y los de sus hijos. Lo usa el BUSCADOR: quien escribe
 * "house" espera que salga tambien el deep house y el tech house.
 *
 * Es una expansion sobre un conjunto CERRADO de tags canonicos —o el disco
 * lleva uno de los tres, o no sale—, no una coincidencia de texto. La
 * diferencia importa: lo que habia que evitar era que "deep house" casara por
 * palabras sueltas con cualquier tag que llevara "house", incluidos 108 discos
 * de drum & bass.
 *
 * El DESPLEGABLE no usa esto: su pildora filtra exacto.
 */
export function tagsConHijos(id) {
  const hijos = GENRES.filter(g => g.padre === id).map(g => genreTag(g.id));
  return [genreTag(id), ...hijos];
}

/**
 * Guiones, barras y subrayados valen como espacio: el cliente escribe
 * "deep-house" o "drum/and/bass" y espera lo mismo que "deep house". Lo de
 * quitar la puntuacion no afecta a los TAGS, que van pegados y con prefijo.
 */
const norm = s => String(s || '').trim().toLowerCase().replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ');

/** raw (en minusculas) → { id, tipo } */
const INDICE = (() => {
  const m = new Map();
  for (const g of GENRES) for (const a of g.alias) m.set(norm(a.raw), { id: g.id, tipo: a.tipo });
  return m;
})();
const POR_ID = new Map(GENRES.map(g => [g.id, g]));
const PRIORIDAD = GENRES.map(g => g.id);   // el orden del array ES la prioridad

/**
 * De los valores crudos de un producto al genero canonico. Devuelve null
 * cuando ninguno resuelve: un producto sin genero se queda SIN genero. El
 * fallback de "coge el primer tag no estructural" es lo que lleno el
 * desplegable de "blue" y "Carl Craig", y no vuelve.
 */
export function resolveGenre(valores) {
  const hits = new Set();
  for (const v of (valores || [])) {
    const hit = INDICE.get(norm(v));
    if (hit) hits.add(hit.id);
  }
  const id = PRIORIDAD.find(x => hits.has(x));
  return id ? { id, label: POR_ID.get(id).label, seccion: POR_ID.get(id).seccion, tag: genreTag(id) } : null;
}

/** ¿Este valor crudo se borra del producto, se conserva, o no lo conocemos? */
export function clasificaValor(v) {
  const n = norm(v);
  if (RUIDO_DE_PRENSADO.some(x => norm(x) === n)) return 'conservar';
  if (NO_SON_GENEROS.some(x => norm(x) === n)) return 'borrar';
  const hit = INDICE.get(n);
  if (!hit) return 'desconocido';
  return hit.tipo === 'sub' ? 'conservar' : 'borrar';   // 'canonico' y 'misma' se borran: los sustituye genre:<id>
}

/**
 * El genero de un producto, leido de su tag canonico. Sin coincidencia, null:
 * un disco sin genero se queda sin genero. Compara sin distinguir mayusculas
 * porque Shopify unifica los tags que solo difieren en eso y conserva la
 * grafia que llego primero.
 */
export function generoDeTags(tags) {
  const bajos = (tags || []).map(t => String(t).toLowerCase());
  for (const g of GENRES) if (bajos.includes(genreTag(g.id))) return { id: g.id, label: g.label, seccion: g.seccion };
  return null;
}

/**
 * El desplegable de una seccion. Nunca se calcula del catalogo.
 *
 * Sale ordenado por `orden` —de mas discos a menos, que es como lo mira un
 * cliente— y no por el orden del array, que es la PRIORIDAD de resolucion y no
 * se toca: ahi `house` va el ultimo a proposito, para que un disco con "Deep
 * House" y "House" resuelva a deep house.
 */
export function generosDeSeccion(seccion) {
  return GENRES.filter(g => g.seccion === seccion)
    .slice()
    .sort((a, b) => (a.orden || 99) - (b.orden || 99))
    .map(g => ({ id: g.id, label: g.label, tag: genreTag(g.id), pildora: g.pildora || 'siempre' }));
}

/**
 * Las pildoras de una seccion: los generos que resuelven MENOS los
 * 'con-discos' que no esten en `conDiscos` (Set de ids con al menos un disco en
 * esa seccion). Sin el Set, esos no salen: ante la duda, nunca una pildora a cero.
 */
export function pildorasDeSeccion(seccion, conDiscos = new Set()) {
  return generosDeSeccion(seccion).filter(g => g.pildora !== 'con-discos' || conDiscos.has(g.id));
}

/** La seccion de D&B, definida por el genero canonico y no por una lista de tags. */
export const DNB_GENRE_ID = 'drumandbass';
