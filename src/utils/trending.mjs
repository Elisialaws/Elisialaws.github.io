// GitHub Trending 的抓取解析与列表渲染，供三处复用：
//   1. scripts/fetch-trending.mjs —— 构建前抓快照，写进 src/data/github-trending.json
//   2. src/components/TrendingList.astro —— 首屏直接输出快照（SSR，SEO 友好）
//   3. worker.ts —— Cloudflare 上的 /api/trending，请求时实时抓取
//
// 为什么抓 HTML 而不是用 API：GitHub 没有官方的 trending 接口，
// Search API 只能按 stars 排序（等于「最热的仓库」而不是「当下在涨的仓库」），
// 和 trending 页的语义差得很远。这个页面结构十几年没大变，正则够用。
//
// 写成 .mjs 而不是 .ts 是刻意的：Node 脚本、Astro 构建、Wrangler 打包都能
// 直接读，不需要额外的转译链路。Tailwind 的 content 里也包含了 mjs，
// 所以下面的类名照样会被扫描进产物。

export const TRENDING_SOURCE = "https://github.com/trending";
export const TRENDING_PERIODS = ["daily", "weekly", "monthly"];
export const TRENDING_LIMIT = 20;

/** 抓取失败时最少的可接受条数，低于这个数认为页面结构变了 */
const MIN_ITEMS = 5;

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const LANG_COLORS = {
	TypeScript: "#3178c6",
	JavaScript: "#f1e05a",
	Python: "#3572A5",
	Rust: "#dea584",
	Go: "#00ADD8",
	C: "#555555",
	"C++": "#f34b7d",
	"C#": "#178600",
	Java: "#b07219",
	Kotlin: "#A97BFF",
	Swift: "#F05138",
	Ruby: "#701516",
	PHP: "#4F5D95",
	Shell: "#89e051",
	HTML: "#e34c26",
	CSS: "#563d7c",
	Vue: "#41b883",
	Svelte: "#ff3e00",
	Dart: "#00B4AB",
	Zig: "#ec915c",
	Lua: "#000080",
	Elixir: "#6e4a7e",
	Haskell: "#5e5086",
	Jupyter: "#DA5B0B",
	"Jupyter Notebook": "#DA5B0B",
};

// Font Awesome solid 的星标与分叉，直接内联成独立 svg：
// astro-icon 在构建时输出的是 <use href="#sprite"> 引用，客户端没法复用，
// 而首屏与实时数据必须长得一模一样，所以统一用自包含的 svg。
const ICON_STAR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512" width="1.13em" height="1em" class="text-[0.7rem]" aria-hidden="true"><path fill="currentColor" d="M316.9 18c-5.3-11-16.5-18-28.8-18s-23.4 7-28.8 18L195 150.3L51.4 171.5c-12 1.8-22 10.2-25.7 21.7s-.7 24.2 7.9 32.7L137.8 329l-24.6 145.7c-2 12 3 24.2 12.9 31.3s23 8 33.8 2.3l128.3-68.5l128.3 68.5c10.8 5.7 23.9 4.9 33.8-2.3s14.9-19.3 12.9-31.3L438.5 329l104.2-103.1c8.6-8.5 11.7-21.2 7.9-32.7s-13.7-19.9-25.7-21.7l-143.7-21.2z"/></svg>`;
const ICON_FORK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512" width="0.88em" height="1em" class="text-[0.7rem]" aria-hidden="true"><path fill="currentColor" d="M80 104a24 24 0 1 0 0-48a24 24 0 1 0 0 48m80-24c0 32.8-19.7 61-48 73.3V192c0 17.7 14.3 32 32 32h160c17.7 0 32-14.3 32-32v-38.7c-28.3-12.3-48-40.5-48-73.3c0-44.2 35.8-80 80-80s80 35.8 80 80c0 32.8-19.7 61-48 73.3V192c0 53-43 96-96 96h-48v70.7c28.3 12.3 48 40.5 48 73.3c0 44.2-35.8 80-80 80s-80-35.8-80-80c0-32.8 19.7-61 48-73.3V288h-48c-53 0-96-43-96-96v-38.7C19.7 141 0 112.8 0 80C0 35.8 35.8 0 80 0s80 35.8 80 80m208 24a24 24 0 1 0 0-48a24 24 0 1 0 0 48M248 432a24 24 0 1 0-48 0a24 24 0 1 0 48 0"/></svg>`;

// ───────────────────────────── 解析 ─────────────────────────────

function stripTags(html) {
	return html
		.replace(/<svg[\s\S]*?<\/svg>/g, " [svg] ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ")
		.trim();
}

function toNumber(text) {
	if (!text) return 0;
	return Number(text.replace(/,/g, "")) || 0;
}

/** 解析一个 <article class="Box-row"> 块 */
export function parseTrendingArticle(block) {
	const text = stripTags(block);

	// 仓库名：h2 里的第一个 /owner/repo 链接
	const repoMatch = block.match(
		/<h2 class="h3 lh-condensed">[\s\S]*?href="\/([^/"?#]+)\/([^/"?#]+)"/,
	);
	if (!repoMatch) return null;
	const [, owner, name] = repoMatch;

	const descMatch = block.match(
		/<p class="col-9 color-fg-muted my-1[^"]*">([\s\S]*?)<\/p>/,
	);
	const description = descMatch ? stripTags(descMatch[1]) : "";

	const langMatch = block.match(
		/<span itemprop="programmingLanguage">([^<]+)<\/span>/,
	);
	const language = langMatch ? langMatch[1].trim() : "";

	// 纯文本里依次出现：总 stars、forks、...+N stars today/this week/this month
	const statsMatch = text.match(/\[svg\]\s*([\d,]+)\s*\[svg\]\s*([\d,]+)/);
	const gainedMatch = text.match(
		/([\d,]+)\s+stars?\s+(today|this week|this month)/,
	);

	return {
		owner,
		name,
		fullName: `${owner}/${name}`,
		url: `https://github.com/${owner}/${name}`,
		description,
		language,
		stars: statsMatch ? toNumber(statsMatch[1]) : 0,
		forks: statsMatch ? toNumber(statsMatch[2]) : 0,
		gained: gainedMatch ? toNumber(gainedMatch[1]) : 0,
	};
}

/**
 * 解析 trending 页 HTML。
 * @param {string} html
 * @param {number} limit
 * @returns {Array<object>} 解析出的仓库列表
 * @throws 当解析结果少得可疑时抛错（页面结构可能变了）
 */
export function parseTrendingHtml(html, limit = TRENDING_LIMIT) {
	const blocks =
		html.match(/<article class="Box-row">[\s\S]*?<\/article>/g) ?? [];
	const items = blocks
		.map(parseTrendingArticle)
		.filter(Boolean)
		.slice(0, limit);

	if (items.length < MIN_ITEMS) {
		throw new Error(`只解析出 ${items.length} 条，页面结构可能变了`);
	}
	return items;
}

/**
 * 抓一个榜单。
 * @param {"daily"|"weekly"|"monthly"} period
 * @param {{limit?: number, timeout?: number, query?: string}} [options]
 *   query 是 GitHub 的筛选串（?since=daily&spoken_language_code=zh 之类），
 *   用来按语言过滤，供 Worker 支持 ?lang= 参数。
 * @returns {Promise<Array<object>>}
 */
export async function fetchTrendingPeriod(period, options = {}) {
	const { limit = TRENDING_LIMIT, timeout = 15_000, query = "" } = options;
	const url = `${TRENDING_SOURCE}?since=${period}${query ? `&${query}` : ""}`;
	const res = await fetch(url, {
		headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
		signal: AbortSignal.timeout(timeout),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return parseTrendingHtml(await res.text(), limit);
}

// ───────────────────────────── 渲染 ─────────────────────────────

function escapeHtml(value) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const numberFormat = new Intl.NumberFormat("en-US");
const fmtNumber = (n) => numberFormat.format(Number(n) || 0);

/**
 * 渲染一个榜单面板里的所有行（不含面板外壳）。
 * 首屏 SSR 与前端拿到实时数据后重绘用的是同一个函数，避免两份结构走样。
 *
 * @param {Array<object>} items
 * @param {{unit?: string, empty?: string, stars?: string, forks?: string}} [labels]
 * @returns {string} HTML
 */
export function renderTrendingRows(items, labels = {}) {
	const { unit = "", empty = "", stars = "stars", forks = "forks" } = labels;
	const list = Array.isArray(items) ? items : [];

	if (list.length === 0) {
		return `<div class="card-base rounded-[var(--radius-large)] p-8 text-center text-75 text-sm">${escapeHtml(empty)}</div>`;
	}

	return list
		.map((repo, index) => {
			const rankClass = index < 3 ? "text-[var(--primary)]" : "text-50";
			const color = LANG_COLORS[repo.language] ?? "#8b949e";
			const language = repo.language
				? `<span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full" style="background-color: ${color}"></span>${escapeHtml(repo.language)}</span>`
				: "";
			const gained =
				repo.gained > 0
					? `<span class="text-xs font-semibold text-[var(--primary)] tabular-nums">+${fmtNumber(repo.gained)}<span class="text-50 font-normal ml-1">${escapeHtml(unit)}</span></span>`
					: "";
			const description = repo.description
				? `<div class="text-75 text-sm mt-1 line-clamp-2 leading-relaxed">${escapeHtml(repo.description)}</div>`
				: "";

			return `<a href="${escapeHtml(repo.url)}" target="_blank" rel="noopener" class="card-base rounded-[var(--radius-large)] px-4 py-3.5 md:px-5 flex gap-3.5 group transition"><div class="w-7 shrink-0 pt-0.5 text-center"><span class="text-sm font-bold tabular-nums ${rankClass}">${index + 1}</span></div><img src="https://github.com/${escapeHtml(repo.owner)}.png?size=64" alt="" loading="lazy" width="32" height="32" class="w-8 h-8 rounded-lg shrink-0 bg-black/[0.04] dark:bg-white/[0.08]" /><div class="min-w-0 flex-1"><div class="flex flex-wrap items-baseline gap-x-2 gap-y-1"><span class="font-bold text-[0.95rem] text-90 truncate transition group-hover:text-[var(--primary)]">${escapeHtml(repo.fullName)}</span>${gained}</div>${description}<div class="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-50">${language}<span class="flex items-center gap-1 tabular-nums">${ICON_STAR}${fmtNumber(repo.stars)}<span class="sr-only">${escapeHtml(stars)}</span></span><span class="flex items-center gap-1 tabular-nums">${ICON_FORK}${fmtNumber(repo.forks)}<span class="sr-only">${escapeHtml(forks)}</span></span></div></div></a>`;
		})
		.join("");
}
