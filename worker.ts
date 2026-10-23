/**
 * Cloudflare Worker for 汐浅的博客 (https://xiqian-blog.xiqian-blog.workers.dev)
 *
 * - Serves the static site built into ./dist (via the ASSETS binding)
 * - Provides a small page-view counter API backed by D1:
 *     GET /api/views/<slug>  →  { "count": <number> }   (increments the counter)
 * - Provides the live GitHub Trending feed used by /trending/:
 *     GET /api/trending      →  { "fetchedAt": "...", "daily": [...], ... }
 *
 * 趋势页本身是静态的，首屏渲染的是构建时的快照；这份接口让页面在打开后
 * 换成当下的榜单，所以 Cloudflare 那份不需要等下一次部署才更新。
 * 抓取结果在边缘缓存一小时，避免每次访问都去打 GitHub。
 *
 * <slug> is the shared article slug (e.g. "hello-world"): the Chinese and
 * English versions of one article count into the same number.
 * See src/utils/content-utils.ts → getPostUrlSlug().
 */

import {
	fetchTrendingPeriod,
	TRENDING_PERIODS,
	TRENDING_SOURCE,
	type TrendingPeriod,
	type TrendingRepo,
} from "./src/utils/trending.mjs";

// Workers 运行时自带 caches.default，仓库里没有装 @cloudflare/workers-types，
// 这里只声明用到的两个方法
interface CacheApi {
	match(request: Request): Promise<Response | undefined>;
	put(request: Request, response: Response): Promise<void>;
}
declare const caches: { default: CacheApi };

interface D1PreparedStatement {
	bind(...values: unknown[]): D1PreparedStatement;
	run(): Promise<unknown>;
	first<T = Record<string, unknown>>(): Promise<T | null>;
}

interface Env {
	ASSETS: { fetch(request: Request): Promise<Response> };
	DB: { prepare(query: string): D1PreparedStatement };
}

interface Context {
	waitUntil(promise: Promise<unknown>): void;
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

/** 全部榜单都抓成功时缓存一小时；只抓到一部分就缩到 10 分钟，好尽快补全 */
const TRENDING_TTL_FULL = 3600;
const TRENDING_TTL_PARTIAL = 600;

/**
 * /api/trending —— 现场抓 GitHub Trending，边缘缓存一小时。
 *
 * 页面首屏渲染的是构建快照，前端拿到这份数据后重绘，所以哪怕很久没部署，
 * Cloudflare 那份看到的也是当下的榜单。抓取失败时返回 502，前端继续用快照。
 */
async function handleTrending(url: URL, ctx: Context): Promise<Response> {
	const cache = caches.default;
	// 缓存键固定成站点自身的 /api/trending，不受查询串影响
	const cacheKey = new Request(
		new URL("/api/trending", url.origin).toString(),
		{
			method: "GET",
		},
	);

	const cached = await cache.match(cacheKey);
	if (cached) return cached;

	const results = await Promise.all(
		TRENDING_PERIODS.map(async (period) => {
			try {
				const items = await fetchTrendingPeriod(period as TrendingPeriod, {
					timeout: 8000,
				});
				return [period, items] as const;
			} catch (error) {
				console.error(`trending ${period} failed:`, error);
				return [period, [] as TrendingRepo[]] as const;
			}
		}),
	);

	const payload: Record<string, unknown> = {
		fetchedAt: new Date().toISOString(),
		source: TRENDING_SOURCE,
	};
	let filled = 0;
	for (const [period, items] of results) {
		payload[period] = items;
		if (items.length > 0) filled += 1;
	}

	// 一个榜单都没抓到：不缓存，下次访问再试
	if (filled === 0) {
		return json({ error: "trending unavailable" }, 502);
	}

	const ttl =
		filled === TRENDING_PERIODS.length
			? TRENDING_TTL_FULL
			: TRENDING_TTL_PARTIAL;
	const response = new Response(JSON.stringify(payload), {
		status: 200,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": `public, max-age=${ttl}, s-maxage=${ttl}`,
			"access-control-allow-origin": "*",
		},
	});

	ctx.waitUntil(cache.put(cacheKey, response.clone()));
	return response;
}

export default {
	async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
		const url = new URL(request.url);
		const match = url.pathname.match(/^\/api\/views\/([^/]+)\/?$/);

		if (/^\/api\/trending\/?$/.test(url.pathname)) {
			if (request.method !== "GET") {
				return json({ error: "method not allowed" }, 405);
			}
			return handleTrending(url, ctx);
		}

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
