import { type CollectionEntry, getCollection } from "astro:content";
import I18nKey from "@i18n/i18nKey";
import { i18n, type Locale } from "@i18n/translation";
import { getCategoryUrl } from "@utils/url-utils.ts";

/** Whether a post's `lang` frontmatter field belongs to the given site locale.
 *  Chinese is the default: empty or missing `lang` counts as Chinese. */
export function postMatchesLocale(
	lang: string | undefined | null,
	locale: Locale,
): boolean {
	const l = (lang || "").toLowerCase();
	if (locale === "en") {
		return l === "en" || l.startsWith("en-") || l.startsWith("en_");
	}
	return l === "" || l === "zh" || l.startsWith("zh-") || l.startsWith("zh_");
}

/** URL slug of a post entry. In legacy collections `id` is the file path
 *  (e.g. "hello-world.en.md"), so the extension and the ".en" translation
 *  marker are stripped: the English "<name>.en.md" maps to the same
 *  "/posts/<name>/" path as its Chinese "<name>.md" counterpart.
 *  Note: entry.slug cannot be used for this — it is slugified and drops dots
 *  ("hello-world.en" → "hello-worlden"). */
export function getPostUrlSlug(entry: { id: string }): string {
	return entry.id.replace(/\.(md|mdx)$/i, "").replace(/\.en$/i, "");
}

// // Retrieve posts and sort them by publication date
async function getRawSortedPosts(locale: Locale = "zh") {
	const allBlogPosts = await getCollection("posts", ({ data }) => {
		if (import.meta.env.PROD && data.draft === true) return false;
		return postMatchesLocale(data.lang, locale);
	});

	const sorted = allBlogPosts.sort((a, b) => {
		const dateA = new Date(a.data.published);
		const dateB = new Date(b.data.published);
		return dateA > dateB ? -1 : 1;
	});
	return sorted;
}

export async function getSortedPosts(locale: Locale = "zh") {
	const sorted = await getRawSortedPosts(locale);

	for (let i = 1; i < sorted.length; i++) {
		sorted[i].data.nextSlug = getPostUrlSlug(sorted[i - 1]);
		sorted[i].data.nextTitle = sorted[i - 1].data.title;
	}
	for (let i = 0; i < sorted.length - 1; i++) {
		sorted[i].data.prevSlug = getPostUrlSlug(sorted[i + 1]);
		sorted[i].data.prevTitle = sorted[i + 1].data.title;
	}

	return sorted;
}
export type PostForList = {
	slug: string;
	data: CollectionEntry<"posts">["data"];
};
export async function getSortedPostsList(
	locale: Locale = "zh",
): Promise<PostForList[]> {
	const sortedFullPosts = await getRawSortedPosts(locale);

	// delete post.body
	const sortedPostsList = sortedFullPosts.map((post) => ({
		slug: getPostUrlSlug(post),
		data: post.data,
	}));

	return sortedPostsList;
}
export type Tag = {
	name: string;
	count: number;
};

export async function getTagList(locale: Locale = "zh"): Promise<Tag[]> {
	const allBlogPosts = await getCollection<"posts">("posts", ({ data }) => {
		if (import.meta.env.PROD && data.draft === true) return false;
		return postMatchesLocale(data.lang, locale);
	});

	const countMap: { [key: string]: number } = {};
	allBlogPosts.forEach((post: { data: { tags: string[] } }) => {
		post.data.tags.forEach((tag: string) => {
			if (!countMap[tag]) countMap[tag] = 0;
			countMap[tag]++;
		});
	});

	// sort tags
	const keys: string[] = Object.keys(countMap).sort((a, b) => {
		return a.toLowerCase().localeCompare(b.toLowerCase());
	});

	return keys.map((key) => ({ name: key, count: countMap[key] }));
}

export type Category = {
	name: string;
	count: number;
	url: string;
};

export async function getCategoryList(locale: Locale = "zh"): Promise<Category[]> {
	const allBlogPosts = await getCollection<"posts">("posts", ({ data }) => {
		if (import.meta.env.PROD && data.draft === true) return false;
		return postMatchesLocale(data.lang, locale);
	});
	const count: { [key: string]: number } = {};
	allBlogPosts.forEach((post: { data: { category: string | null } }) => {
		if (!post.data.category) {
			const ucKey = i18n(I18nKey.uncategorized, locale);
			count[ucKey] = count[ucKey] ? count[ucKey] + 1 : 1;
			return;
		}

		const categoryName =
			typeof post.data.category === "string"
				? post.data.category.trim()
				: String(post.data.category).trim();

		count[categoryName] = count[categoryName] ? count[categoryName] + 1 : 1;
	});

	const lst = Object.keys(count).sort((a, b) => {
		return a.toLowerCase().localeCompare(b.toLowerCase());
	});

	const ret: Category[] = [];
	for (const c of lst) {
		ret.push({
			name: c,
			count: count[c],
			url: getCategoryUrl(c, locale),
		});
	}
	return ret;
}

/** Check whether a translated counterpart of the post with the given canonical
 *  URL slug exists in the target locale (used by the language switch button).
 *  English post slugs carry a ".en" suffix internally; it is stripped here so
 *  "<name>.en.md" pairs with the Chinese "<name>.md". */
export async function findPostBySlug(
	slug: string,
	locale: Locale,
): Promise<boolean> {
	const posts = await getCollection("posts", ({ id, data }) => {
		if (import.meta.env.PROD && data.draft === true) return false;
		return (
			getPostUrlSlug({ id }) === slug &&
			postMatchesLocale(data.lang, locale)
		);
	});
	return posts.length > 0;
}
