import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	getAlertsState, setEmailAlerts, refreshStoredEmail, unsubscribeByToken,
	buildDigests, renderAlertEmail, alertSubject, runFollowAlerts, MAX_PER_EMAIL, ctaFor,
	snoozeAlertsPrompt, PROMPT_COOLDOWN_MS,
} from "../src/lib/alerts";
import { addFollow } from "../src/lib/follows";

const CID = "555000111";
const OTRO = "555000222";

async function wipe() {
	for (const prefix of ["entity:", "alias:", "children:", "follow:", "fanout:", "feedindex:", "entityindex:", "alertsent:", "alerttoken:", "meta:"]) {
		const l = await env.ENTITIES.list({ prefix, limit: 1000 });
		for (const k of l.keys) await env.ENTITIES.delete(k.name);
	}
}
async function entidad(slug: string, display: string, roles = ["artist"], extra: any = {}) {
	await env.ENTITIES.put(`entity:${slug}`, JSON.stringify({
		slug, display, roles, aliases: [], sources: ["test"], status: "active", createdAt: 1, updatedAt: 1, ...extra }));
}
const hace = (h: number) => new Date(Date.now() - h * 3600000).toISOString();
function prod(handle: string, horas: number, a: string[] = [], l: string[] = [], extra: any = {}) {
	return { id: `gid://p/${handle}`, handle, slug: handle, title: handle.toUpperCase(), vendor: "V",
		createdAt: hace(horas), forthcoming: false, releaseDate: "", imageUrl: `https://cdn/${handle}.jpg`,
		price: "14.99", currency: "EUR", stock: 1, artistSlugs: a, labelSlugs: l, ...extra };
}
async function indice(items: any[]) {
	await env.ENTITIES.put("feedindex:v2", JSON.stringify({ builtAt: Date.now(), items }));
}

describe("consentimiento de avisos", () => {
	beforeEach(async () => { await wipe(); await entidad("omar-s", "Omar S"); });

	it("sin preguntar todavia: asked=false, que es lo que dispara el prompt", async () => {
		await addFollow(env as any, CID, "omar-s");
		expect(await getAlertsState(env as any, CID)).toMatchObject({ asked: false, emailAlerts: false });
	});

	it("decir que NO tambien cuenta como preguntado: no se vuelve a preguntar", async () => {
		await addFollow(env as any, CID, "omar-s");
		await setEmailAlerts(env as any, CID, false);
		expect(await getAlertsState(env as any, CID)).toMatchObject({ asked: true, emailAlerts: false });
	});

	it("al decir que si guarda el correo — sin el, el cron no puede avisar", async () => {
		await addFollow(env as any, CID, "omar-s");
		await setEmailAlerts(env as any, CID, true, "e@example.com");
		const st = await getAlertsState(env as any, CID);
		expect(st).toMatchObject({ asked: true, emailAlerts: true, email: "e@example.com" });
		// …y un token de baja, para que el correo lleve su enlace.
		const f = JSON.parse((await env.ENTITIES.get(`follow:${CID}`))!);
		expect(f.alertToken).toMatch(/^[0-9a-f]{48}$/);
		expect(await env.ENTITIES.get(`alerttoken:${f.alertToken}`)).toBe(CID);
	});

	it("encender no pisa la lista de seguidos", async () => {
		await addFollow(env as any, CID, "omar-s");
		await setEmailAlerts(env as any, CID, true, "e@example.com");
		expect(JSON.parse((await env.ENTITIES.get(`follow:${CID}`))!).entities).toEqual(["omar-s"]);
	});

	it("el correo guardado se refresca cuando el cliente pasa por el portal", async () => {
		await setEmailAlerts(env as any, CID, true, "viejo@example.com");
		await refreshStoredEmail(env as any, CID, "nuevo@example.com");
		expect((await getAlertsState(env as any, CID)).email).toBe("nuevo@example.com");
	});

	it("la baja por token apaga los avisos y no toca nada mas", async () => {
		await addFollow(env as any, CID, "omar-s");
		await setEmailAlerts(env as any, CID, true, "e@example.com");
		const token = JSON.parse((await env.ENTITIES.get(`follow:${CID}`))!).alertToken;
		expect(await unsubscribeByToken(env as any, token)).toBe(true);
		const f = JSON.parse((await env.ENTITIES.get(`follow:${CID}`))!);
		expect(f.emailAlerts).toBe(false);
		expect(f.entities).toEqual(["omar-s"]);   // sigue siguiendo
		expect(await unsubscribeByToken(env as any, "inventado")).toBe(false);
	});
});

describe("el recordatorio al seguir a alguien", () => {
	beforeEach(async () => { await wipe(); await entidad("omar-s", "Omar S"); await addFollow(env as any, CID, "omar-s"); });

	const estado = (now?: number) => getAlertsState(env as any, CID, now);

	it("nunca preguntado: se ofrece", async () => {
		expect((await estado()).prompt).toBe(true);
	});

	it("ya los tiene encendidos: no se le dice nada nunca mas", async () => {
		await setEmailAlerts(env as any, CID, true, "e@example.com");
		expect((await estado()).prompt).toBe(false);
		expect((await estado(Date.now() + 10 * PROMPT_COOLDOWN_MS)).prompt).toBe(false);
	});

	it("dijo que no hace dos dias: no se le vuelve a preguntar", async () => {
		await setEmailAlerts(env as any, CID, false);
		expect((await estado(Date.now() + 2 * 24 * 3600000)).prompt).toBe(false);
	});

	it("dijo que no hace mas de un mes: al seguir a otro se le recuerda", async () => {
		await setEmailAlerts(env as any, CID, false);
		expect((await estado(Date.now() + PROMPT_COOLDOWN_MS + 1000)).prompt).toBe(true);
	});

	it("apagarlos desde el portal tambien cuenta como respuesta reciente", async () => {
		await setEmailAlerts(env as any, CID, true, "e@example.com");
		await setEmailAlerts(env as any, CID, false);
		expect((await estado()).prompt).toBe(false);
	});

	it("cerrarlo sin contestar lo aparta, pero no lo da por contestado", async () => {
		await snoozeAlertsPrompt(env as any, CID);
		expect(await estado()).toMatchObject({ prompt: false, asked: false });
		expect((await estado(Date.now() + PROMPT_COOLDOWN_MS + 1000)).prompt).toBe(true);
	});

	it("apartarlo no toca ni la preferencia ni la lista de seguidos", async () => {
		await snoozeAlertsPrompt(env as any, CID);
		const f = JSON.parse((await env.ENTITIES.get(`follow:${CID}`))!);
		expect(f.entities).toEqual(["omar-s"]);
		expect(f.emailAlerts).toBeUndefined();
	});
});

describe("a quien le toca que", () => {
	beforeEach(async () => {
		await wipe();
		await entidad("omar-s", "Omar S");
		await entidad("deep-jungle", "Deep Jungle", ["label"]);
	});

	it("solo a quien lo pidio y tiene correo", async () => {
		await indice([prod("nuevo", 3, ["omar-s"])]);
		await addFollow(env as any, CID, "omar-s");
		await setEmailAlerts(env as any, CID, true, "si@example.com");
		await addFollow(env as any, OTRO, "omar-s");            // sigue, pero no pidio avisos

		const d = await buildDigests(env as any, { sinceMs: 24 * 3600000 });
		expect(d.map(x => x.cid)).toEqual([CID]);
		expect(d[0].groups[0]).toMatchObject({ slug: "omar-s", display: "Omar S" });
		expect(d[0].total).toBe(1);
	});

	it("lo de fuera de la ventana no cuenta", async () => {
		await indice([prod("viejo", 40, ["omar-s"])]);
		await addFollow(env as any, CID, "omar-s");
		await setEmailAlerts(env as any, CID, true, "si@example.com");
		expect(await buildDigests(env as any, { sinceMs: 24 * 3600000 })).toEqual([]);
	});

	it("un pre-order es novedad: es justo lo que se quiere saber antes", async () => {
		await indice([prod("pre", 2, ["omar-s"], [], { forthcoming: true })]);
		await addFollow(env as any, CID, "omar-s");
		await setEmailAlerts(env as any, CID, true, "si@example.com");
		const d = await buildDigests(env as any, { sinceMs: 24 * 3600000 });
		expect(d[0].groups[0].items[0].forthcoming).toBe(true);
	});

	it("agrupa por entidad y ordena por cuantas novedades trae cada una", async () => {
		await indice([prod("a", 1, [], ["deep-jungle"]), prod("b", 2, [], ["deep-jungle"]), prod("c", 3, ["omar-s"])]);
		await addFollow(env as any, CID, "omar-s");
		await addFollow(env as any, CID, "deep-jungle");
		await setEmailAlerts(env as any, CID, true, "si@example.com");
		const d = await buildDigests(env as any, { sinceMs: 24 * 3600000 });
		expect(d[0].groups.map(g => [g.slug, g.items.length])).toEqual([["deep-jungle", 2], ["omar-s", 1]]);
		expect(d[0].total).toBe(3);
	});

	it("quien sigue al sello padre recibe lo del sub-sello", async () => {
		await entidad("chiwax", "Chiwax", ["label"]);
		await entidad("chiwax-classic-edition", "Chiwax Classic Edition", ["label"], { parent: "chiwax" });
		await indice([prod("delhijo", 4, [], ["chiwax-classic-edition"])]);
		await addFollow(env as any, CID, "chiwax");
		await setEmailAlerts(env as any, CID, true, "si@example.com");
		const d = await buildDigests(env as any, { sinceMs: 24 * 3600000 });
		expect(d[0].groups.map(g => g.slug)).toEqual(["chiwax"]);
		expect(d[0].groups[0].items[0].handle).toBe("delhijo");
	});

	it("un disco que traen dos seguidos sale UNA vez, y se lo queda el artista", async () => {
		await entidad("dj-koze", "DJ Koze");
		await entidad("pampa", "Pampa", ["label"]);
		await indice([prod("xtc", 2, ["dj-koze"], ["pampa"])]);
		await addFollow(env as any, CID, "dj-koze");
		await addFollow(env as any, CID, "pampa");
		await setEmailAlerts(env as any, CID, true, "si@example.com");
		const d = await buildDigests(env as any, { sinceMs: 24 * 3600000 });
		expect(d[0].groups.map(g => [g.slug, g.items.length])).toEqual([["dj-koze", 1]]);
		expect(d[0].groups[0].items[0].alsoFrom).toEqual(["Pampa"]);
		// El asunto cuenta discos, no apariciones.
		expect(d[0].total).toBe(1);
		expect(alertSubject(d[0])).toBe("DJ Koze: XTC");
	});

	it("dos artistas seguidos del mismo disco: manda el primero de la ficha", async () => {
		await entidad("massive-attack", "Massive Attack");
		await entidad("mad-professor", "Mad Professor");
		await indice([prod("boots", 2, ["massive-attack", "mad-professor"], ["play-it-again-sam"])]);
		await addFollow(env as any, CID, "mad-professor");
		await addFollow(env as any, CID, "massive-attack");
		await setEmailAlerts(env as any, CID, true, "si@example.com");
		const d = await buildDigests(env as any, { sinceMs: 24 * 3600000 });
		expect(d[0].groups.map(g => g.slug)).toEqual(["massive-attack"]);
		expect(d[0].groups[0].items[0].alsoFrom).toEqual(["Mad Professor"]);
		expect(d[0].total).toBe(1);
	});

	it("sin artista seguido detras, el disco se queda en el sello", async () => {
		await entidad("pampa", "Pampa", ["label"]);
		await indice([prod("solo-sello", 2, ["nadie"], ["pampa"])]);
		await addFollow(env as any, CID, "pampa");
		await setEmailAlerts(env as any, CID, true, "si@example.com");
		const d = await buildDigests(env as any, { sinceMs: 24 * 3600000 });
		expect(d[0].groups.map(g => g.slug)).toEqual(["pampa"]);
		expect(d[0].groups[0].items[0].alsoFrom).toBeUndefined();
	});

	it("el tope y el \"and N more\" cuentan discos unicos, no apariciones", async () => {
		await entidad("dj-koze", "DJ Koze");
		await entidad("pampa", "Pampa", ["label"]);
		// 2 discos, cada uno bajo artista Y sello: sin deduplicar serian 4.
		await indice([prod("x1", 2, ["dj-koze"], ["pampa"]), prod("x2", 3, ["dj-koze"], ["pampa"])]);
		await addFollow(env as any, CID, "dj-koze");
		await addFollow(env as any, CID, "pampa");
		await setEmailAlerts(env as any, CID, true, "si@example.com");
		const d = await buildDigests(env as any, { sinceMs: 24 * 3600000 });
		expect(d[0].total).toBe(2);
		const html = renderAlertEmail(d[0], "https://w/x");
		expect((html.match(/<table role="presentation"/g) || []).length).toBe(2);
		expect(html).toContain("also from Pampa");
		expect(html).not.toContain("And ");
	});

	it("sin novedades, nadie recibe nada", async () => {
		await indice([prod("nada-suyo", 1, ["otro"])]);
		await addFollow(env as any, CID, "omar-s");
		await setEmailAlerts(env as any, CID, true, "si@example.com");
		expect(await buildDigests(env as any, { sinceMs: 24 * 3600000 })).toEqual([]);
	});
});

describe("el correo", () => {
	const digest = (n: number) => ({
		cid: CID, email: "e@example.com", token: "tok",
		groups: [{ slug: "omar-s", display: "Omar S", items: Array.from({ length: n }, (_, i) => prod(`p${i}`, 1, ["omar-s"])) }],
		total: n,
	}) as any;

	it("lleva el enlace de baja y dice que no afecta al newsletter", () => {
		const html = renderAlertEmail(digest(1), "https://w/?action=follow-alerts-unsubscribe&t=tok");
		// El & va escapado en el href, que es lo correcto en HTML.
		expect(html).toContain("follow-alerts-unsubscribe&amp;t=tok");
		expect(html.toLowerCase()).toContain("newsletter");
	});

	it("corta en el tope y resume el resto", () => {
		const html = renderAlertEmail(digest(MAX_PER_EMAIL + 7), "https://w/x");
		expect((html.match(/<table role="presentation"/g) || []).length).toBe(MAX_PER_EMAIL);
		// El correo va en ingles, como toda la tienda de cara al cliente.
		expect(html).toContain("And 7 more");
	});

	it("cuando lo traen varios seguidos, el disco los nombra en una linea", () => {
		const d = digest(1);
		d.groups[0].items[0].alsoFrom = ["Pampa", "Soul Intent", "Mooncraft"];
		const html = renderAlertEmail(d, "https://w/x");
		expect(html).toContain("also from Pampa, Soul Intent and Mooncraft");
	});

	it("el asunto dice lo que hay, sin prometer de mas", () => {
		expect(alertSubject(digest(1))).toBe("Omar S: P0");
		expect(alertSubject(digest(3))).toBe("Omar S: 3 new records");
	});
});

describe("la tanda", () => {
	let fetchOriginal: typeof fetch;
	let enviados: any[];

	beforeEach(async () => {
		await wipe();
		await entidad("omar-s", "Omar S");
		await indice([prod("nuevo", 2, ["omar-s"])]);
		await addFollow(env as any, CID, "omar-s");
		await setEmailAlerts(env as any, CID, true, "cliente@example.com");
		enviados = [];
		fetchOriginal = globalThis.fetch;
		globalThis.fetch = (async (url: any, init: any) => {
			if (String(url).includes('api.resend.com')) {
				enviados.push(JSON.parse(init.body));
				return new Response('{"id":"x"}', { status: 200 });
			}
			return fetchOriginal(url, init);
		}) as any;
		(env as any).RESEND_API_KEY = 'test';
	});
	afterEach(() => { globalThis.fetch = fetchOriginal; vi.restoreAllMocks(); });

	it("en off no manda nada, digan lo que digan los datos", async () => {
		const r = await runFollowAlerts(env as any, { mode: 'off' });
		expect(r.sent).toBe(0);
		expect(enviados).toHaveLength(0);
	});

	it("en test manda a UNA direccion y no gasta el registro del dia", async () => {
		const r = await runFollowAlerts(env as any, { mode: 'test', testTo: 'eduardo@example.com' });
		expect(r.sent).toBe(1);
		expect(enviados[0].to).toBe('eduardo@example.com');
		// Sin registro: se puede repetir la prueba las veces que haga falta.
		const dia = new Date().toISOString().slice(0, 10);
		expect(await env.ENTITIES.get(`alertsent:${CID}:${dia}`)).toBeNull();
		const otra = await runFollowAlerts(env as any, { mode: 'test', testTo: 'eduardo@example.com' });
		expect(otra.sent).toBe(1);
	});

	it("en live manda al cliente y no repite el mismo dia", async () => {
		const r1 = await runFollowAlerts(env as any, { mode: 'live' });
		expect(r1.sent).toBe(1);
		expect(enviados[0].to).toBe('cliente@example.com');

		const r2 = await runFollowAlerts(env as any, { mode: 'live' });
		expect(r2.sent).toBe(0);
		expect(r2.skipped_already_sent).toBe(1);
		expect(enviados).toHaveLength(1);
	});

	it("si Resend falla, se cuenta como fallo y no tumba la tanda", async () => {
		globalThis.fetch = (async (url: any, init: any) => {
			if (String(url).includes('api.resend.com')) return new Response('nope', { status: 500 });
			return fetchOriginal(url, init);
		}) as any;
		const r = await runFollowAlerts(env as any, { mode: 'live' });
		expect(r.failed).toBe(1);
		expect(r.errors[0]).toContain('resend 500');
	});
});

describe("la preferencia de avisos sobrevive a lo demas", () => {
	beforeEach(async () => {
		await wipe();
		await entidad("omar-s", "Omar S");
		await entidad("rawax", "Rawax", ["label"]);
	});

	it("seguir a otra entidad NO apaga los avisos", async () => {
		// El fallo real: saveFollows reescribia el blob entero con {entities,
		// updatedAt} y se llevaba por delante emailAlerts, el correo y el token.
		await addFollow(env as any, CID, "omar-s");
		await setEmailAlerts(env as any, CID, true, "e@example.com");
		const token = JSON.parse((await env.ENTITIES.get(`follow:${CID}`))!).alertToken;

		await addFollow(env as any, CID, "rawax");

		const st = await getAlertsState(env as any, CID);
		expect(st).toMatchObject({ emailAlerts: true, asked: true, email: "e@example.com" });
		const f = JSON.parse((await env.ENTITIES.get(`follow:${CID}`))!);
		expect(f.alertToken).toBe(token);          // el enlace de baja sigue valiendo
		expect(f.entities).toEqual(["omar-s", "rawax"]);
	});

	it("dejar de seguir tampoco los apaga", async () => {
		await addFollow(env as any, CID, "omar-s");
		await addFollow(env as any, CID, "rawax");
		await setEmailAlerts(env as any, CID, true, "e@example.com");
		const { removeFollow } = await import("../src/lib/follows");
		await removeFollow(env as any, CID, "rawax");
		expect(await getAlertsState(env as any, CID)).toMatchObject({ emailAlerts: true, email: "e@example.com" });
	});
});

describe("el boton de cada disco", () => {
	const base: any = { stock: 0, forthcoming: false, year: 0 };
	const ahora = Date.parse("2026-09-11T12:00:00Z");

	it("con stock, lleva a la ficha a comprar", () => {
		expect(ctaFor({ ...base, stock: 3 }, ahora)).toEqual({ label: "View record", backorder: false });
	});

	it("agotado y reciente: se puede pedir", () => {
		expect(ctaFor({ ...base, year: 2026 }, ahora).label).toBe("Request a copy");
		expect(ctaFor({ ...base, year: 2025 }, ahora).label).toBe("Request a copy");
	});

	it("agotado y viejo: NO promete lo que la ficha no ofrece", () => {
		// isBackorderEligible() de la tienda corta en el año anterior. Si el
		// correo dijera "Request a copy", al llegar no habria formulario.
		expect(ctaFor({ ...base, year: 2024 }, ahora).label).toBe("View record");
		expect(ctaFor({ ...base, year: 0 }, ahora).label).toBe("View record");
	});

	it("un pre-order lleva a la ficha, que es donde se reserva", () => {
		expect(ctaFor({ ...base, forthcoming: true, stock: 0, year: 2026 }, ahora).label).toBe("View record");
	});
});

describe("salida al portal y baja", () => {
	const d: any = { cid: "1", email: "e@x", token: "t",
		groups: [{ slug: "omar-s", display: "Omar S", items: [prod("p", 1, ["omar-s"])] }], total: 1 };

	it("siempre hay enlace al portal, no solo cuando el correo se corta", () => {
		const html = renderAlertEmail(d, "https://w/x");
		expect(html).toContain("See all in your account");
		expect(html).toContain("houseonly.store/account");
	});

	it("la cabecera lleva el logo, y su alt dice la marca por si se bloquean las imagenes", () => {
		const html = renderAlertEmail(d, "https://w/x");
		expect(html).toContain("brand/houseonly-logo.png");
		expect(html).toContain('alt="HOUSE ONLY"');
	});

	it("la baja va en su propia linea y se lee", () => {
		const html = renderAlertEmail(d, "https://w/unsub?t=tok");
		expect(html).toContain("Stop these alerts");
		expect(html).toContain("text-decoration:underline");
	});
});

describe("pie del correo", () => {
	it("dice que no se conteste y a donde ir si esta agotado", () => {
		const d: any = { cid: "1", email: "e@x", token: "t",
			groups: [{ slug: "omar-s", display: "Omar S", items: [prod("p", 1, ["omar-s"])] }], total: 1 };
		const html = renderAlertEmail(d, "https://w/x");
		expect(html).toContain("Don't reply to this email.");
		expect(html).toContain("Request a copy from the record page.");
	});
});

describe("cabeceras de baja en un clic", () => {
	let fetchOriginal: typeof fetch;
	let peticiones: any[];

	beforeEach(async () => {
		await wipe();
		await entidad("omar-s", "Omar S");
		await indice([prod("nuevo", 2, ["omar-s"])]);
		await addFollow(env as any, CID, "omar-s");
		await setEmailAlerts(env as any, CID, true, "cliente@example.com");
		peticiones = [];
		fetchOriginal = globalThis.fetch;
		globalThis.fetch = (async (url: any, init: any) => {
			if (String(url).includes('api.resend.com')) { peticiones.push(JSON.parse(init.body)); return new Response('{"id":"x"}', { status: 200 }); }
			return fetchOriginal(url, init);
		}) as any;
		(env as any).RESEND_API_KEY = 'test';
	});
	afterEach(() => { globalThis.fetch = fetchOriginal; });

	it("van las dos, y la URL es la misma que la del pie", async () => {
		await runFollowAlerts(env as any, { mode: 'test', testTo: 'e@x', workerUrl: 'https://w' });
		const h = peticiones[0].headers;
		expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
		expect(h['List-Unsubscribe']).toMatch(/^<https:\/\/w\/\?action=follow-alerts-unsubscribe&t=.+>$/);
		// El cliente de correo y el humano acaban en el mismo sitio.
		const url = h['List-Unsubscribe'].slice(1, -1);
		expect(peticiones[0].html).toContain(url.replace(/&/g, '&amp;'));
	});
});
