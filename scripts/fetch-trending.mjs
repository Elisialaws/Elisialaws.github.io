// 抓取 GitHub Trending 榜单，生成 src/data/github-trending.json
//
// 用法：node scripts/fetch-trending.mjs [--limit=20]
// 构建前自动跑一次（见 package.json 的 prebuild）；抓取失败时保留上一次的
// 快照，不会让构建挂掉。
//
// 解析与抓取逻辑都在 src/utils/trending.mjs，和 worker.ts 的 /api/trending
// 共用同一份代码，避免两边对页面结构的理解跑偏。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	fetchTrendingPeriod,
	TRENDING_PERIODS,
	TRENDING_SOURCE,
} from "../src/utils/trending.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = resolve(__dirname, "../src/data/github-trending.json");

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : 20;

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
		source: TRENDING_SOURCE,
		daily: previous?.daily ?? [],
		weekly: previous?.weekly ?? [],
		monthly: previous?.monthly ?? [],
	};

	let ok = 0;
	for (const period of TRENDING_PERIODS) {
		try {
			snapshot[period] = await fetchTrendingPeriod(period, { limit: LIMIT });
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
	await writeFile(
		OUT_FILE,
		`${JSON.stringify(snapshot, null, "\t")}\n`,
		"utf8",
	);
	console.log(`→ 写入 ${OUT_FILE}`);
}

main().catch((error) => {
	// 抓取是锦上添花的功能，绝不能因为它让部署失败
	console.error("fetch-trending 失败：", error.message);
	process.exitCode = 0;
});
