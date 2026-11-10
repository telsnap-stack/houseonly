import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		// R2 tan estricto como el real con las partes multipart (test/setup/r2-estricto.ts).
		setupFiles: ['./test/setup/r2-estricto.ts'],
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
	},
});
