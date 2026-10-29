import { describe, it, expect, vi, afterEach } from "vitest";
import { configureDiscogsProxy, getListing } from "../src/lib/discogs";

const listing = { id: 7, status: "For Sale", price: { currency: "EUR", value: 10 }, release: { id: 1, catalog_number: "X", description: "" }, uri: "" };
const ok = () => new Response(JSON.stringify(listing), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => { vi.restoreAllMocks(); configureDiscogsProxy({}); });

describe("Discogs fixed-IP proxy", () => {
	it("unset: goes straight to api.discogs.com", async () => {
		const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());
		configureDiscogsProxy({});
		await getListing("tok", 7);
		expect(String(f.mock.calls[0][0])).toBe("https://api.discogs.com/marketplace/listings/7");
	});

	it("set: same path on the proxy, with its key and the Discogs token", async () => {
		const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());
		configureDiscogsProxy({ DISCOGS_PROXY_URL: "https://discogs-proxy.example/", DISCOGS_PROXY_KEY: "k" });
		await getListing("tok", 7);
		expect(f).toHaveBeenCalledTimes(1);
		expect(String(f.mock.calls[0][0])).toBe("https://discogs-proxy.example/marketplace/listings/7");
		const h = (f.mock.calls[0][1] as any).headers;
		expect(h["X-Proxy-Key"]).toBe("k");
		expect(h["Authorization"]).toBe("Discogs token=tok");
	});

	it("proxy unreachable or 502/403: falls back to the direct call", async () => {
		configureDiscogsProxy({ DISCOGS_PROXY_URL: "https://discogs-proxy.example", DISCOGS_PROXY_KEY: "k" });
		for (const fail of [() => Promise.reject(new Error("connect failed")), () => Promise.resolve(new Response("", { status: 502 })), () => Promise.resolve(new Response("", { status: 403 }))]) {
			const f = vi.spyOn(globalThis, "fetch").mockImplementationOnce(fail as any).mockResolvedValueOnce(ok());
			expect((await getListing("tok", 7)).id).toBe(7);
			expect(String(f.mock.calls[1][0])).toBe("https://api.discogs.com/marketplace/listings/7");
			expect((f.mock.calls[1][1] as any).headers["X-Proxy-Key"]).toBeUndefined();
			f.mockRestore();
		}
	});
});
