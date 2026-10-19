// Las consultas del catalogo para `products(query:)` de la Storefront API.
// Viven aqui y no en App.jsx para poder probarlas (node --test src/) sin
// montar React: la rejilla, las pildoras y el buscador dependen de que digan
// exactamente lo que dicen.
import { genreTag, DNB_GENRE_ID, resolveGenre, tagsConHijos } from '../houseonly-worker/houseonly-worker/src/lib/genres.mjs';
import { EXCLUIR_TARJETAS } from './giftcard.mjs';

// La seccion de Drum & Bass se define por el GENERO CANONICO, leido del modulo
// compartido (src/lib/genres.mjs), no por una lista de grafias. Antes habia un
// DNB_TAGS con seis escrituras a mano que no cubria "Drum + Bass" ni
// "Jungle / Drum 'n' Bass", y esos discos se colaban entre el house.
const DNB_TAG = genreTag(DNB_GENRE_ID);

// Las clausulas que definen una seccion de la tienda. Las comparten la rejilla
// (fetchShopifyProducts) y la comprobacion de pildoras (hayDiscosEnSeccion), para
// que "hay discos" signifique exactamente lo que la rejilla va a mostrar.
export function clausulasDeSeccion({ filterTags = [], forthcoming = false, dnb = false } = {}) {
  // Build a tag-AND query string for server-side filtering. Each filterTag is a
  // raw tag value like "label:Word and Sound" or "year:2025".
  //
  // Forthcoming handling (mutually exclusive, drives the Forthcoming section vs
  // the main catalogue):
  //   - forthcoming=true  → REQUIRE the `forthcoming` tag  → only pre-orders
  //   - forthcoming=false → EXCLUDE it via `-tag:'forthcoming'` so pre-orders
  //     never leak into the main catalogue.
  // Negation ("-tag:...") is supported by Shopify's search query grammar
  // (verified against docs: a "-" modifier excludes documents with that value).
  //
  // Drum & Bass handling (separate "Drum & Bass Only" section):
  //   - dnb=true  → REQUIRE any D&B tag  → only the D&B catalogue
  //   - dnb=false → EXCLUDE all D&B tags so they never appear among the house
  //     genres on the main page. (Forthcoming is exempt — pre-orders can be D&B.)
  //
  // La tarjeta regalo no es un disco: fuera de todas las secciones, y con ella
  // de las pildoras de genero, que preguntan con estas mismas clausulas.
  const clauses = filterTags.map(t => `tag:'${t}'`);
  clauses.push(EXCLUIR_TARJETAS);
  clauses.push(forthcoming ? `tag:'forthcoming'` : `-tag:'forthcoming'`);
  if (dnb) {
    clauses.push(`tag:'${DNB_TAG}'`);
  } else if (!forthcoming) {
    // Main catalogue: hide every D&B record from the house genres.
    clauses.push(`-tag:'${DNB_TAG}'`);
  }
  return clauses;
}

/**
 * Las partes (unidas por espacio = AND) de la consulta del buscador. Si el
 * termino ENTERO es un genero, la consulta es su tag canonico; si no, texto
 * libre. Ver el comentario largo en fetchShopifyProductSearch (App.jsx).
 */
export function partesDeBusqueda({ termino = '', forthcoming = false, filterTags = [] } = {}) {
  termino = String(termino || '').trim();
  const genero = resolveGenre([termino]);
  // Un genero con hijos los arrastra: "house" trae tambien deep house y tech
  // house. La lista sale del modulo y es cerrada.
  const texto = genero
    ? (t => t.length > 1 ? `(${t.map(x => `tag:'${x}'`).join(' OR ')})` : `tag:'${t[0]}'`)(tagsConHijos(genero.id))
    : termino;
  const queryParts = [texto, forthcoming ? `tag:'forthcoming'` : `-tag:'forthcoming'`];
  for (const t of filterTags) queryParts.push(`tag:'${t}'`);
  // Buscar "gift" tampoco mezcla la tarjeta regalo con los discos.
  queryParts.push(EXCLUIR_TARJETAS);
  // El BUSCADOR no se reparte por secciones. La separacion entre house y drum &
  // bass es para navegar; buscar es otra cosa: quien escribe "Fokuz" quiere sus
  // discos, y Fokuz es un sello de D&B. Con el filtro de seccion puesto, esa
  // busqueda devolvia "No records found" con 81 discos en la tienda, y lo mismo
  // cualquier artista de jungle buscado desde la portada.
  //
  // Lo de `forthcoming` si se mantiene: un pre-order no es lo mismo que algo en
  // stock, y ahi la separacion es de estado, no de estilo.
  /**
   * `products(query:)` y no `search(...)`: medido contra el catalogo, el
   * conector `search` NO respeta el OR booleano —devolvia MENOS resultados que
   * el texto solo— y sin OR no hay forma de sumar el tag del genero. La
   * coincidencia por prefijo se conserva igual ("pamp" encuentra los 10 de
   * Pampa), y las descripciones se siguen indexando.
   */
  return queryParts;
}
