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

/** 站点自身的 origin，用作缓存键；定时任务里没有请求可以用来取 origin */
const SITE_ORIGIN = "https://xiqian-blog.xiqian-blog.workers.dev";

/**
 * 趋势数据的刷新策略：定时抓，访问时只读缓存。
 *
 * - `wrangler.jsonc` 里挂了 cron（每天 01:17 UTC = 北京时间 09:17），
 *   由 scheduled() 在后台跑一次抓取，把结果写进边缘缓存；
 * - 页面访问时只读缓存，命中就直接返回，不会去碰 GitHub；
 * - 缓存 TTL 给到 26 小时，保证两次定时之间不会失效（也就意味着正常情况
 *   每天只抓 3 次：三个榜单各一次）；
 * - 只有缓存彻底过期（例如定时任务连续失败）时，才会在请求里补抓一次。
 *
 * 浏览器侧单独给 1 小时，页面自己还有 1 小时的 sessionStorage 缓存，
 * 所以一个访客一小时内最多发一次请求。
 */
const TRENDING_TTL_SECONDS = 26 * 3600;
const TRENDING_TTL_PARTIAL_SECONDS = 10 * 60;
const TRENDING_BROWSER_TTL_SECONDS = 3600;

type TrendingPayload = {
	fetchedAt: string;
	source: string;
	daily: TrendingRepo[];
	weekly: TrendingRepo[];
	monthly: TrendingRepo[];
};

function trendingCacheKey(): Request {
	// 固定成站点自身的 /api/trending：不受查询串影响，定时任务与请求共用同一条
	return new Request(new URL("/api/trending", SITE_ORIGIN).toString(), {
		method: "GET",
	});
}

/** 抓三个榜单；失败的档位留空数组，返回抓到的档数 */
async function collectTrending(): Promise<{
	payload: TrendingPayload;
	filled: number;
}> {
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

	const payload: TrendingPayload = {
		fetchedAt: new Date().toISOString(),
		source: TRENDING_SOURCE,
		daily: [],
		weekly: [],
		monthly: [],
	};
	let filled = 0;
	for (const [period, items] of results) {
		payload[period] = items;
		if (items.length > 0) filled += 1;
	}
	return { payload, filled };
}

function trendingResponse(payload: TrendingPayload, filled: number): Response {
	// 三档都抓到才享受 26 小时；只抓到一部分就短一点，好尽快补全
	const ttl =
		filled === TRENDING_PERIODS.length
			? TRENDING_TTL_SECONDS
			: TRENDING_TTL_PARTIAL_SECONDS;
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: {
			"content-type": "application/json; charset=utf-8",
			// s-maxage 决定边缘缓存，max-age 决定浏览器缓存
			"cache-control": `public, max-age=${TRENDING_BROWSER_TTL_SECONDS}, s-maxage=${ttl}`,
			"access-control-allow-origin": "*",
		},
	});
}

/**
 * /api/trending —— 读缓存的实时榜单。
 * 正常情况缓存总是被定时任务填着，这里直接命中；只有过期才会现场补抓。
 */
async function handleTrending(ctx: Context): Promise<Response> {
	const cacheKey = trendingCacheKey();

	const cached = await caches.default.match(cacheKey);
	if (cached) return cached;

	const { payload, filled } = await collectTrending();
	// 一个榜单都没抓到：不缓存，下次访问再试
	if (filled === 0) {
		return json({ error: "trending unavailable" }, 502);
	}

	const response = trendingResponse(payload, filled);
	ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
	return response;
}

/**
 * 定时任务：每天重建一次趋势缓存（见 wrangler.jsonc 的 triggers.crons）。
 * 抓取失败就保留旧缓存，不清空 —— 宁可慢一天，也不要让页面上出现空榜。
 */
async function refreshTrending(ctx: Context): Promise<void> {
	const { payload, filled } = await collectTrending();
	if (filled === 0) {
		console.error("cron: 三个榜单全部抓取失败，保留旧缓存");
		return;
	}
	const response = trendingResponse(payload, filled);
	ctx.waitUntil(caches.default.put(trendingCacheKey(), response));
	console.log(
		`cron: 趋势缓存已刷新 fetchedAt=${payload.fetchedAt} filled=${filled}`,
	);
}

export default {
	async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
		const url = new URL(request.url);
		const match = url.pathname.match(/^\/api\/views\/([^/]+)\/?$/);

		if (/^\/api\/trending\/?$/.test(url.pathname)) {
			if (request.method !== "GET") {
				return json({ error: "method not allowed" }, 405);
			}
			return handleTrending(ctx);
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

	/**
	 * Cron Triggers 入口（wrangler.jsonc → triggers.crons）。
	 * 每天固定时间把趋势缓存重建一次，访问时就不用去打 GitHub 了。
	 */
	async scheduled(
		controller: { cron: string },
		_env: Env,
		ctx: Context,
	): Promise<void> {
		console.log(`cron ${controller.cron} 触发趋势刷新`);
		await refreshTrending(ctx);
	},
};
