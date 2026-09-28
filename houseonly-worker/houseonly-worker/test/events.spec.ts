import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
	eventsToShow,
	formatEventDate,
	formatEventPlace,
	getEvents,
	handleEventsPut,
	handleEventsGet,
	EVENTS_STALE_MS,
	MAX_EVENTS_SHOWN,
	type EventsRecord,
} from "../src/lib/events";

// Datos reales de Bandsintown, Jeff Mills el 2026-09-18.
const SECRET = "test-secret";
const AHORA = Date.parse("2026-09-18T12:00:00Z");

const ev = (id: string, date: string, city: string, extra: any = {}) => ({ id, date, city, ...extra });
const rec = (items: any[], fetchedAt = AHORA): EventsRecord => ({ slug: "jeff-mills", source: "bandsintown", items, fetchedAt });

function req(action: string, body?: any) {
	return new Request(`https://w/?action=${action}`, {
		method: body ? "POST" : "GET",
		headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
}

describe("formato", () => {
	it("fecha con dia, y con año solo si no es este", () => {
		expect(formatEventDate("2026-09-27T23:00:00", AHORA)).toBe("Sun 27 Sep");
		expect(formatEventDate("2027-01-09T21:00:00", AHORA)).toBe("Sat 9 Jan 2027");
		expect(formatEventDate("no es una fecha", AHORA)).toBe("");
	});

	it("sitio: ciudad y pais, con estado solo donde ayuda", () => {
		expect(formatEventPlace(ev("1", "x", "Ibiza", { country: "Spain", region: "Balearic Islands" }) as any)).toBe("Ibiza, Spain");
		expect(formatEventPlace(ev("2", "x", "Detroit", { country: "United States", region: "MI" }) as any)).toBe("Detroit, MI, United States");
		expect(formatEventPlace(ev("3", "x", "Sète") as any)).toBe("Sète");
	});
});

describe("eventsToShow", () => {
	it("solo futuras y ordenadas", () => {
		const r = rec([
			ev("b", "2026-10-09T20:00:00", "Sète"),
			ev("a", "2026-09-27T23:00:00", "Ibiza"),
			ev("viejo", "2026-09-01T20:00:00", "Berlin"),
		]);
		expect(eventsToShow(r, AHORA).map(e => e.id)).toEqual(["a", "b"]);
	});

	it("el dia del concierto cuenta entero", () => {
		const r = rec([ev("hoy", "2026-09-18T23:00:00", "Tokyo")]);
		expect(eventsToShow(r, AHORA)).toHaveLength(1);
	});

	it("una lista vieja no se enseña: una fecha caducada hace mas daño que ninguna", () => {
		const r = rec([ev("a", "2027-01-01T20:00:00", "Lyon")], AHORA - EVENTS_STALE_MS - 1000);
		expect(eventsToShow(r, AHORA)).toEqual([]);
		expect(eventsToShow(null, AHORA)).toEqual([]);
	});

	it("tope de las que se pintan", () => {
		const r = rec(Array.from({ length: MAX_EVENTS_SHOWN + 5 }, (_, i) =>
			ev(String(i), `2026-1${i % 2}-0${(i % 9) + 1}T20:00:00`, "Paris")));
		expect(eventsToShow(r, AHORA).length).toBeLessThanOrEqual(MAX_EVENTS_SHOWN);
	});
});

describe("events-put", () => {
	beforeEach(async () => {
		(env as any).BOOTSTRAP_AUTH_SECRET = SECRET;
		const l = await env.ENTITIES.list({ prefix: "events:", limit: 1000 });
		for (const k of l.keys) await env.ENTITIES.delete(k.name);
	});

	it("guarda lo que se enseña y tira lo incompleto", async () => {
		const r: any = await (await handleEventsPut(req("events-put", { items: [{ slug: "jeff-mills", events: [
			{ id: "1038801574", date: "2026-09-27T23:00:00", city: "Ibiza", country: "Spain", venue: "Amnesia Ibiza",
				url: "https://www.bandsintown.com/e/1038801574", tickets: "https://www.bandsintown.com/t/1038801574" },
			{ id: "sin-ciudad", date: "2026-10-01T20:00:00" },
			{ date: "sin-id", city: "Lyon" },
		] }] }), env as any)).json();
		expect(r).toEqual({ written: 1, skipped: 0, events: 1 });
		const guardado = await getEvents(env as any, "jeff-mills");
		expect(guardado!.items[0]).toMatchObject({ city: "Ibiza", venue: "Amnesia Ibiza", tickets: "https://www.bandsintown.com/t/1038801574" });
	});

	it("una entidad sin fechas se escribe igual: se sabe que se miro", async () => {
		await handleEventsPut(req("events-put", { items: [{ slug: "omar-s", events: [] }] }), env as any);
		const g = await getEvents(env as any, "omar-s");
		expect(g!.items).toEqual([]);
		expect(g!.fetchedAt).toBeGreaterThan(0);
	});

	it("sin Bearer, 401", async () => {
		const r = await handleEventsPut(new Request("https://w/?action=events-put", { method: "POST", body: "{}" }), env as any);
		expect(r.status).toBe(401);
		expect((await handleEventsGet(new Request("https://w/?action=events-get&slug=x"), env as any)).status).toBe(401);
	});
});
