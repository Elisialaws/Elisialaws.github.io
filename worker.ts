/**
 * Cloudflare Worker for 汐浅的博客 (https://xiqian-blog.xiqian-blog.workers.dev)
 *
 * - Serves the static site built into ./dist (via the ASSETS binding)
 * - Provides a small page-view counter API backed by D1:
 *     GET /api/views/<slug>  →  { "count": <number> }   (increments the counter)
 *
 * <slug> is the shared article slug (e.g. "hello-world"): the Chinese and
 * English versions of one article count into the same number.
 * See src/utils/content-utils.ts → getPostUrlSlug().
 */

interface D1PreparedStatement {
	bind(...values: unknown[]): D1PreparedStatement;
	run(): Promise<unknown>;
	first<T = Record<string, unknown>>(): Promise<T | null>;
}

interface Env {
	ASSETS: { fetch(request: Request): Promise<Response> };
	DB: { prepare(query: string): D1PreparedStatement };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const match = url.pathname.match(/^\/api\/views\/([^/]+)\/?$/);

		if (match) {
			if (request.method !== "GET") {
				return json({ error: "method not allowed" }, 405);
			}
			let slug: string;
			try {
				slug = decodeURIComponent(match[1]);
			} catch {
				return json({ error: "invalid slug" }, 400);
			}
			slug = slug.trim().slice(0, 120);
			if (!slug || /[\u0000-\u001f]/.test(slug)) {
				return json({ error: "invalid slug" }, 400);
			}
			try {
				await env.DB.prepare(
					"INSERT INTO views (slug, count) VALUES (?, 1) ON CONFLICT(slug) DO UPDATE SET count = count + 1",
				)
					.bind(slug)
					.run();
				const row = await env.DB.prepare(
					"SELECT count FROM views WHERE slug = ?",
				)
					.bind(slug)
					.first<{ count: number }>();
				return json({ count: Number(row?.count ?? 0) });
			} catch (error) {
				console.error("view counter failed:", error);
				return json({ error: "counter unavailable" }, 500);
			}
		}

		// Everything else is a static asset (custom 404 handling included).
		return env.ASSETS.fetch(request);
	},
};
