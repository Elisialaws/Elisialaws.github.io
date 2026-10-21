// 抓取 GitHub Trending 榜单，生成 src/data/github-trending.json
//
// 用法：node scripts/fetch-trending.mjs [--limit=20]
// 构建前手动跑一次即可；抓取失败时保留上一次的快照，不会让构建挂掉。
//
// 为什么抓 HTML 而不是用 API：GitHub 没有官方的 trending 接口，
// Search API 只能按 stars 排序（等于「最热的仓库」而不是「当下在涨的仓库」），
// 和 trending 页的语义差得很远。这个页面结构十几年没大变，正则够用。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = resolve(__dirname, "../src/data/github-trending.json");

const PERIODS = ["daily", "weekly", "monthly"];
const PERIOD_LABEL = {
	daily: "stars today",
	weekly: "stars this week",
	monthly: "stars this month",
};

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : 20;

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

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
function parseArticle(block) {
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
	const statsMatch = text.match(
		/\[svg\]\s*([\d,]+)\s*\[svg\]\s*([\d,]+)/,
	);
	const gainedMatch = text.match(/([\d,]+)\s+stars?\s+(today|this week|this month)/);

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

async function fetchPeriod(period) {
	const url = `https://github.com/trending?since=${period}`;
	const res = await fetch(url, {
		headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`${period}: HTTP ${res.status}`);

	const html = await res.text();
	const blocks = html.match(/<article class="Box-row">[\s\S]*?<\/article>/g) ?? [];
	const items = blocks
		.map(parseArticle)
		.filter(Boolean)
		.slice(0, LIMIT);

	if (items.length < 5) {
		throw new Error(`${period}: 只解析出 ${items.length} 条，页面结构可能变了`);
	}
	return items;
}

async function readSnapshot() {
	try {
		return JSON.parse(await readFile(OUT_FILE, "utf8"));
	} catch {
		return null;
	}
}

async function main() {
	// SKIP_TRENDING=1 pnpm build —— 离线或想跳过抓取时用
	if (process.env.SKIP_TRENDING === "1") {
		console.log("SKIP_TRENDING=1，跳过抓取，沿用现有快照");
		return;
	}

	const previous = await readSnapshot();
	const snapshot = {
		fetchedAt: new Date().toISOString(),
		source: "https://github.com/trending",
		daily: previous?.daily ?? [],
		weekly: previous?.weekly ?? [],
		monthly: previous?.monthly ?? [],
	};

	let ok = 0;
	for (const period of PERIODS) {
		try {
			snapshot[period] = await fetchPeriod(period);
			ok += 1;
			console.log(
				`✓ ${period}: ${snapshot[period].length} 条，榜首 ${snapshot[period][0]?.fullName}`,
			);
		} catch (error) {
			console.warn(`✗ ${period}: ${error.message}（沿用旧快照）`);
		}
	}

	if (ok === 0 && previous) {
		console.warn("全部抓取失败，保留原快照，不改写文件");
		return;
	}

	await mkdir(dirname(OUT_FILE), { recursive: true });
	await writeFile(OUT_FILE, `${JSON.stringify(snapshot, null, "\t")}\n`, "utf8");
	console.log(`→ 写入 ${OUT_FILE}`);
	console.log(`  ${PERIOD_LABEL.daily} / ${PERIOD_LABEL.weekly} / ${PERIOD_LABEL.monthly}`);
}

main().catch((error) => {
	// 抓取是锦上添花的功能，绝不能因为它让部署失败
	console.error("fetch-trending 失败：", error.message);
	process.exitCode = 0;
});
