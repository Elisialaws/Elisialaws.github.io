import { getCollection, type CollectionEntry } from "astro:content";
import type { Locale } from "@i18n/translation";
import { getPostUrlSlug, postMatchesLocale } from "./content-utils";
import { url } from "./url-utils";

/**
 * 标签落地页（/tags/<slug>/ 与 /en/tags/<slug>/）。
 *
 * 归档页的 `?tag=` 只是站内过滤，URL 不可索引；这里给每个标签生成一个真实
 * 页面，让「Docker」「vLLM」这类标签能被搜索引擎收录、也能直接分享。
 */

export type TagLanding = {
	/** URL 段，例如 "ai-infra"、"c++" */
	slug: string;
	/** 展示名：同一 slug 下出现最多的原始写法 */
	name: string;
	/** 该 slug 涵盖的所有原始写法（"AI Infra" 与 "ai-infra" 会合并） */
	names: string[];
	count: number;
};

/**
 * 把标签变成 URL 安全的 slug。
 *
 * 规则：小写 → 空白与下划线折叠成连字符 → 只保留字母、数字、CJK、
 * `+ . -` → 合并多余连字符。所以 "AI Infra" → "ai-infra"，"C++" → "c++"，
 * "Node.js" → "node.js"。中文标签保留原字（URL 里是百分号编码，
 * 但目录名和分享链接仍然可读）。
 */
export function tagToSlug(tag: string): string {
	const slug = tag
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/[^\p{L}\p{N}+.-]/gu, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");

	// 空串、"." 和 ".." 会拼出奇怪路径，统一兜底
	if (slug === "" || slug === "." || slug === "..") return "tag";
	return slug;
}

/** 标签总览页地址 */
export function getTagIndexUrl(lang: Locale = "zh"): string {
	return lang === "en" ? url("/en/tags/") : url("/tags/");
}

/** 单个标签落地页地址（slug 已生成） */
export function getTagLandingUrlBySlug(
	slug: string,
	lang: Locale = "zh",
): string {
	return lang === "en"
		? url(`/en/tags/${slug}/`)
		: url(`/tags/${slug}/`);
}

/** 单个标签落地页地址（传原始标签名，内部转 slug） */
export function getTagLandingUrl(tag: string, lang: Locale = "zh"): string {
	return getTagLandingUrlBySlug(tagToSlug(tag), lang);
}

/** 当前语种下参与建站的文章（生产环境过滤草稿） */
async function getLocalePosts(
	locale: Locale,
): Promise<CollectionEntry<"posts">[]> {
	const posts = await getCollection("posts", ({ data }) => {
		if (import.meta.env.PROD && data.draft === true) return false;
		return postMatchesLocale(data.lang, locale);
	});
	return posts.sort((a, b) => {
		const dateA = new Date(a.data.published).getTime();
		const dateB = new Date(b.data.published).getTime();
		return dateB - dateA;
	});
}

/** 所有标签落地页，按文章数倒序、再按名称 */
export async function getTagLandings(locale: Locale): Promise<TagLanding[]> {
	const posts = await getLocalePosts(locale);

	const index = new Map<
		string,
		{ names: Map<string, number>; posts: Set<string> }
	>();

	for (const post of posts) {
		const slugInPost = new Set<string>();
		for (const raw of post.data.tags ?? []) {
			const name = raw.trim();
			if (!name) continue;
			const slug = tagToSlug(name);
			// 同一篇文章里 "AI Infra" 和 "ai-infra" 只算一次
			if (slugInPost.has(slug)) {
				const bucket = index.get(slug);
				bucket?.names.set(name, (bucket.names.get(name) ?? 0) + 1);
				continue;
			}
			slugInPost.add(slug);

			let bucket = index.get(slug);
			if (!bucket) {
				bucket = { names: new Map(), posts: new Set() };
				index.set(slug, bucket);
			}
			bucket.names.set(name, (bucket.names.get(name) ?? 0) + 1);
			bucket.posts.add(getPostUrlSlug(post));
		}
	}

	return [...index.entries()]
		.map(([slug, bucket]) => {
			// 展示名：出现最多的写法；并列时取更短的那个
			const names = [...bucket.names.entries()].sort(
				(a, b) => b[1] - a[1] || a[0].length - b[0].length,
			);
			return {
				slug,
				name: names[0]?.[0] ?? slug,
				names: names.map(([n]) => n),
				count: bucket.posts.size,
			};
		})
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** 某个标签落地页下的文章（按发布时间倒序） */
export async function getPostsByTagSlug(
	locale: Locale,
	slug: string,
): Promise<CollectionEntry<"posts">[]> {
	const posts = await getLocalePosts(locale);
	return posts.filter((post) =>
		(post.data.tags ?? []).some((tag) => tagToSlug(tag) === slug),
	);
}

/** 目标语种里是否存在该标签页，供语言切换与 hreflang 判断配对 */
export async function tagSlugExists(
	locale: Locale,
	slug: string,
): Promise<boolean> {
	const landings = await getTagLandings(locale);
	return landings.some((l) => l.slug === slug);
}
