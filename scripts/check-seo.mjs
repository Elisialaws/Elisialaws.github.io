/**
 * 构建后的双语 SEO 自检：确认 sitemap 与页面 <head> 里的 hreflang 都成立。
 *
 * 检查项：
 * 1. sitemap 里声明了 alternate 的条目，必须 zh-CN 与 en 成对出现
 * 2. 每条 alternate 的目标都必须出现在 sitemap 的 <loc> 集合里（防 404 指向）
 * 3. 每个页面都要有 canonical，以及自身语种的那条 hreflang
 * 4. 只有当两个语种页面真实互为镜像时才声明对方（否则只声明自身）
 *
 * 说明：标签页未必成对（中文标签「前端」与英文标签 frontend 是两个不同
 * 主题），这类页面只声明自身语种，脚本记为提示而非错误。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const DIST = "dist";

const errors = [];
const notes = [];

if (!existsSync(DIST)) {
	console.error("check-seo: 找不到 dist/，请先运行 pnpm build");
	process.exit(1);
}

/* ---------- 1. sitemap ---------- */

const sitemapFiles = readdirSync(DIST).filter(
	(name) => name.startsWith("sitemap") && name.endsWith(".xml"),
);
const shards = sitemapFiles.filter((n) => !n.includes("index"));

const entries = [];
for (const file of shards) {
	const xml = readFileSync(join(DIST, file), "utf8");
	for (const block of xml.match(/<url>[\s\S]*?<\/url>/g) ?? []) {
		const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1];
		if (!loc) continue;
		const links = [...block.matchAll(/hreflang="([^"]+)"\s+href="([^"]+)"/g)].map(
			(m) => ({ hreflang: m[1], href: m[2] }),
		);
		entries.push({ loc, links });
	}
}

if (entries.length === 0) {
	errors.push("sitemap 里没有任何 <url> 条目");
}

const locSet = new Set(entries.map((e) => e.loc));
let declared = 0;
let singleLang = 0;

for (const entry of entries) {
	if (entry.links.length === 0) {
		singleLang++;
		continue;
	}
	declared++;

	const langs = new Set(entry.links.map((l) => l.hreflang));
	for (const required of ["zh-CN", "en"]) {
		if (!langs.has(required)) {
			errors.push(
				`sitemap: ${entry.loc} 已声明 alternate，但缺少 hreflang="${required}"`,
			);
		}
	}
	for (const link of entry.links) {
		if (!locSet.has(link.href)) {
			errors.push(
				`sitemap: ${entry.loc} 的 ${link.hreflang} 指向 ${link.href}，该地址不在 sitemap 中`,
			);
		}
	}
	const selfLang = entry.loc.includes("/en/") ? "en" : "zh-CN";
	const self = entry.links.find((l) => l.hreflang === selfLang);
	if (!self) {
		errors.push(`sitemap: ${entry.loc} 的 alternate 里缺少自身语种 ${selfLang}`);
	}
}

/* ---------- 2. 页面 <head> ---------- */

const htmlFiles = [];
(function walk(dir) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (name === "pagefind") continue;
		const st = statSync(full);
		if (st.isDirectory()) walk(full);
		else if (name.endsWith(".html")) htmlFiles.push(full);
	}
})(DIST);

for (const file of htmlFiles) {
	const html = readFileSync(file, "utf8");
	const page = `/${relative(DIST, file).replace(/\\/g, "/")}`;
	if (page.includes("404")) continue;

	if (!/<link[^>]+rel="canonical"/.test(html)) {
		errors.push(`${page} 缺少 canonical`);
	}

	const isEn = /^\/en(\/|$)/.test(page);
	const selfLang = isEn ? "en" : "zh-CN";
	if (!new RegExp(`hreflang="${selfLang}"`).test(html)) {
		errors.push(`${page} 缺少自身语种的 hreflang="${selfLang}"`);
	}

	// 两个语种都声明时，应同时给出 x-default
	const hasZh = /hreflang="zh-CN"/.test(html);
	const hasEn = /hreflang="en"/.test(html);
	if (hasZh && hasEn && !/hreflang="x-default"/.test(html)) {
		notes.push(`${page} 同时声明了中英版本，但缺 x-default`);
	}
}

/* ---------- 输出 ---------- */

console.log(
	`check-seo: sitemap ${entries.length} 条（成对 ${declared} / 单语 ${singleLang}），页面 ${htmlFiles.length} 个`,
);

if (notes.length > 0) {
	console.log(`\n提示 ${notes.length} 条：`);
	for (const n of notes.slice(0, 20)) console.log(`  - ${n}`);
}

if (errors.length > 0) {
	console.error(`\n错误 ${errors.length} 条：`);
	for (const e of errors.slice(0, 40)) console.error(`  - ${e}`);
	process.exit(1);
}

console.log("hreflang / canonical 全部通过 ✓");
