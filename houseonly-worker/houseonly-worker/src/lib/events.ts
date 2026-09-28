// ── FECHAS DE CONCIERTO (FASE 7E) ───────────────────────────────────
//
// docs/entities.md. Decision de Eduardo, 2026-09-18: **nada de widgets**. Las
// fechas se pintan como una lista nuestra, con el aspecto de la tienda, y el
// cliente no sale de aqui.
//
// De donde salen: Bandsintown, y solo para entidades cuyo id de artista ha
// verificado una persona (el MBID que devuelve su ficha es el que ya estaba
// aprobado). Quien las pide es `scripts/entities-events-fetch.mjs`, a mano y a
// 1 peticion por segundo; el worker NO llama a Bandsintown.
//
// Lo que se guarda es lo minimo que se enseña —fecha, ciudad, pais, sala— mas
// la URL de entradas, que es la fase siguiente.
//
// RA no esta y no va a estar mientras sus terminos digan lo que dicen: §4.4
// prohibe extraer datos de su web de forma automatica con fines comerciales, y
// no publican API ni widget. Su enlace sigue en la ficha, y ya.
//
// Clave:  events:{slug} → EventsRecord

import type { EntitiesEnv } from './entities';

export interface LiveEvent {
  id: string;
  // Tal cual lo da la fuente: "2026-09-27T23:00:00", **hora local de la sala y
  // sin zona**. Por eso todo lo que hay debajo trabaja con la fecha de
  // calendario y no la convierte: un bolo a las 23:00 en Ibiza es el 27 aqui y
  // en Detroit, y convertirlo lo movia al 28.
  date: string;
  city: string;
  region?: string;
  country?: string;
  venue?: string;
  url?: string;           // la pagina del evento
  tickets?: string;       // la fase siguiente: comprar la entrada
  festival?: boolean;
}

export interface EventsRecord {
  slug: string;
  source: 'bandsintown';
  items: LiveEvent[];     // ordenadas de la mas proxima a la mas lejana
  fetchedAt: number;
}

/** Cuantas se enseñan en la ficha. Mas que esto ya es una agenda, no un dato. */
export const MAX_EVENTS_SHOWN = 8;
/** Pasado este tiempo sin refrescar, la lista no se enseña: una fecha vieja
 *  hace mas daño que no tener fechas. */
export const EVENTS_STALE_MS = 14 * 24 * 3600 * 1000;

const K = { events: (slug: string) => `events:${slug}` };

export async function getEvents(env: EntitiesEnv, slug: string): Promise<EventsRecord | null> {
  const raw = await env.ENTITIES.get(K.events(slug));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Lo que la ficha debe enseñar: futuras, ordenadas, y nada si la lista lleva
 * demasiado sin refrescarse.
 */
/** "2026-09-27T23:00:00" → "2026-09-27". Nada de husos horarios. */
const soloFecha = (iso: string) => String(iso || '').slice(0, 10);

export function eventsToShow(rec: EventsRecord | null, now = Date.now()): LiveEvent[] {
  if (!rec || now - rec.fetchedAt > EVENTS_STALE_MS) return [];
  const hoy = new Date(now).toISOString().slice(0, 10);
  return (rec.items || [])
    // El dia del concierto cuenta entero: a las 10 de la mañana todavia se
    // anuncia el bolo de esa noche.
    .filter(e => /^\d{4}-\d{2}-\d{2}/.test(e.date) && soloFecha(e.date) >= hoy)
    .sort((a, b) => soloFecha(a.date).localeCompare(soloFecha(b.date)))
    .slice(0, MAX_EVENTS_SHOWN);
}

/** "Sat 27 Sep" · "27 Sep 2027" si cae en otro año. A mano, como en sets.ts. */
const DIAS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MESES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatEventDate(iso: string, now = Date.now()): string {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const [, y, mes, dia] = m.map(Number) as unknown as [string, number, number, number];
  // Se arma en UTC a partir de la fecha de calendario: asi el dia de la semana
  // sale igual se mire desde donde se mire.
  const d = new Date(Date.UTC(y, mes - 1, dia));
  const base = `${DIAS[d.getUTCDay()]} ${dia} ${MESES[mes - 1]}`;
  return y === new Date(now).getUTCFullYear() ? base : `${base} ${y}`;
}

/** "Ibiza, Spain" — la region solo cuando ayuda (Estados Unidos, Canada). */
export function formatEventPlace(e: LiveEvent): string {
  const conRegion = e.region && ['United States', 'Canada', 'USA'].includes(e.country || '');
  return [e.city, conRegion ? e.region : null, e.country].filter(Boolean).join(', ');
}

// ── HANDLERS HTTP ───────────────────────────────────────────────────

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function bearerOk(request: Request, env: EntitiesEnv): boolean {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return !!m && !!env.BOOTSTRAP_AUTH_SECRET && m[1] === env.BOOTSTRAP_AUTH_SECRET;
}

/**
 * POST ?action=events-put  {items: [{slug, events: [...]}]}
 *
 * Lo llama el script. Una entidad sin fechas se escribe igual, con la lista
 * vacia: asi se sabe que se miro y cuando, y no se confunde "no toca" con
 * "nadie lo ha mirado".
 */
export async function handleEventsPut(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);
  let body: any = null;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length || items.length > 50) return json({ error: 'items: 1-50 required' }, 400);

  let written = 0, skipped = 0, total = 0;
  for (const it of items) {
    const slug = String(it?.slug || '');
    if (!slug) { skipped++; continue; }
    const eventos: LiveEvent[] = (Array.isArray(it.events) ? it.events : [])
      .filter((e: any) => e?.id && e?.date && e?.city)
      .map((e: any) => ({
        id: String(e.id), date: String(e.date), city: String(e.city),
        region: e.region || undefined, country: e.country || undefined,
        venue: e.venue || undefined, url: e.url || undefined, tickets: e.tickets || undefined,
        ...(e.festival ? { festival: true } : {}),
      }));
    await env.ENTITIES.put(K.events(slug), JSON.stringify({
      slug, source: 'bandsintown', items: eventos, fetchedAt: Date.now(),
    } satisfies EventsRecord));
    written++; total += eventos.length;
  }
  return json({ written, skipped, events: total });
}

/** GET ?action=events-get&slug=… — depurar. */
export async function handleEventsGet(request: Request, env: EntitiesEnv): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'unauthorized' }, 401);
  const slug = new URL(request.url).searchParams.get('slug') || '';
  if (!slug) return json({ error: 'slug required' }, 400);
  const rec = await getEvents(env, slug);
  return json({ events: rec, showing: eventsToShow(rec) });
}
