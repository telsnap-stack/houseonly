import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
	mixcloudIndex,
	fetchMixcloud,
	refreshMixcloud,
	getMixStat,
	handleMixcloudRefresh,
	MIX_STAT_TTL_MS,
} from "../src/lib/mixcloud";

// Las dos entidades con Mixcloud aprobado en produccion el 2026-09-18:
// defected → Defectedrecords, mark-de-clive-lowe → markdeclivelowe.
const SECRET = "test-secret";

async function wipe() {
	for (const prefix of ["external:", "mixstat:", "meta:"]) {
		const l = await env.ENTITIES.list({ prefix, limit: 1000 });
		for (const k of l.keys) await env.ENTITIES.delete(k.name);
	}
}

async function seedExternal(slug: string, extra: any) {
	await env.ENTITIES.put(`external:${slug}`, JSON.stringify({ slug, approved: {}, rejected: {}, updatedAt: 1, ...extra }));
}

/** Mixcloud de mentira: perfil y ultimo show, con los datos reales de NTS. */
function fakeMixcloud(overrides: Record<string, any> = {}) {
	return (async (url: any) => {
		const u = String(url);
		if (overrides[u] !== undefined) return overrides[u];
		if (u.endsWith("/cloudcasts/?limit=1")) {
			return new Response(JSON.stringify({ data: [{ created_time: "2026-09-14T10:23:37Z", url: "https://www.mixcloud.com/x/show/", name: "El ultimo" }] }));
		}
		return new Response(JSON.stringify({
			name: "Defected Records", follower_count: 90210, cloudcast_count: 812,
			pictures: { thumbnail: "https://thumbnailer.mixcloud.com/x.jpg" },
		}));
	}) as unknown as typeof fetch;
}

describe("mixcloudIndex", () => {
	beforeEach(async () => { await wipe(); (env as any).BOOTSTRAP_AUTH_SECRET = SECRET; });

	it("solo entra quien tiene cuenta aprobada", async () => {
		await seedExternal("defected", { mixcloud: "Defectedrecords" });
		await seedExternal("mark-de-clive-lowe", { mixcloud: "markdeclivelowe" });
		await seedExternal("omar-s", { ra: "dj/omars" });            // sin Mixcloud
		expect((await mixcloudIndex(env as any)).sort()).toEqual(["defected", "mark-de-clive-lowe"]);
	});

	it("se cachea 24 h: una entidad nueva no aparece hasta que caduca", async () => {
		await seedExternal("defected", { mixcloud: "Defectedrecords" });
		await mixcloudIndex(env as any, 1_000_000);
		await seedExternal("mark-de-clive-lowe", { mixcloud: "markdeclivelowe" });
		expect(await mixcloudIndex(env as any, 1_000_000 + 3600_000)).toEqual(["defected"]);
		expect((await mixcloudIndex(env as any, 1_000_000 + 25 * 3600_000)).sort()).toEqual(["defected", "mark-de-clive-lowe"]);
	});
});

describe("fetchMixcloud", () => {
	it("saca perfil y ultimo show", async () => {
		expect(await fetchMixcloud("Defectedrecords", fakeMixcloud())).toEqual({
			name: "Defected Records", avatar: "https://thumbnailer.mixcloud.com/x.jpg",
			followers: 90210, shows: 812,
			last: "2026-09-14T10:23:37Z", lastUrl: "https://www.mixcloud.com/x/show/", lastTitle: "El ultimo",
		});
	});

	it("una cuenta borrada da error, no una excepcion", async () => {
		const f = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
		expect(await fetchMixcloud("ya-no-existe", f)).toEqual({ error: "perfil HTTP 404" });
	});

	it("si falla el ultimo show, el perfil se guarda igual", async () => {
		const f = fakeMixcloud({ "https://api.mixcloud.com/Defectedrecords/cloudcasts/?limit=1": new Response("x", { status: 500 }) });
		const d = await fetchMixcloud("Defectedrecords", f);
		expect(d.followers).toBe(90210);
		expect(d.last).toBeUndefined();
	});
});

describe("refreshMixcloud", () => {
	beforeEach(async () => {
		await wipe();
		(env as any).BOOTSTRAP_AUTH_SECRET = SECRET;
		await seedExternal("defected", { mixcloud: "Defectedrecords" });
		await seedExternal("mark-de-clive-lowe", { mixcloud: "markdeclivelowe" });
	});

	it("refresca las dos y guarda la foto", async () => {
		const r = await refreshMixcloud(env as any, { fetchImpl: fakeMixcloud() });
		expect(r).toMatchObject({ checked: 2, updated: 2, failed: 0 });
		const s = await getMixStat(env as any, "defected");
		expect(s).toMatchObject({ username: "Defectedrecords", followers: 90210, last: "2026-09-14T10:23:37Z" });
	});

	it("no vuelve a pedir lo fresco: 12 h", async () => {
		const now = 10_000_000_000;
		await refreshMixcloud(env as any, { now, fetchImpl: fakeMixcloud() });
		const otra = await refreshMixcloud(env as any, { now: now + 3600_000, fetchImpl: fakeMixcloud() });
		expect(otra).toMatchObject({ checked: 0, skipped: 2 });
		const luego = await refreshMixcloud(env as any, { now: now + MIX_STAT_TTL_MS + 1000, fetchImpl: fakeMixcloud() });
		expect(luego.checked).toBe(2);
	});

	it("un fallo de Mixcloud conserva la foto anterior", async () => {
		await refreshMixcloud(env as any, { fetchImpl: fakeMixcloud() });
		const roto = (async () => new Response("x", { status: 503 })) as unknown as typeof fetch;
		const r = await refreshMixcloud(env as any, { force: true, fetchImpl: roto });
		expect(r).toMatchObject({ failed: 2, updated: 0 });
		const s = await getMixStat(env as any, "defected");
		expect(s!.followers).toBe(90210);          // lo de antes sigue ahi
		expect(s!.error).toMatch(/503/);
	});

	it("el tope por pasada se respeta", async () => {
		const r = await refreshMixcloud(env as any, { limit: 1, fetchImpl: fakeMixcloud() });
		expect(r.checked).toBe(1);
	});

	it("el endpoint pide Bearer", async () => {
		expect((await handleMixcloudRefresh(new Request("https://w/?action=mixcloud-refresh"), env as any)).status).toBe(401);
		const ok = await handleMixcloudRefresh(new Request("https://w/?action=mixcloud-refresh&limit=0", {
			headers: { Authorization: `Bearer ${SECRET}` },
		}), env as any);
		expect(ok.status).toBe(200);
	});
});
