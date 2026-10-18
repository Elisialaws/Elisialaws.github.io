import I18nKey from "@i18n/i18nKey";
import { i18n } from "@i18n/translation";

export function pathsEqual(path1: string, path2: string) {
	const normalizedPath1 = path1.replace(/^\/|\/$/g, "").toLowerCase();
	const normalizedPath2 = path2.replace(/^\/|\/$/g, "").toLowerCase();
	return normalizedPath1 === normalizedPath2;
}

function joinUrl(...parts: string[]): string {
	const joined = parts.join("/");
	return joined.replace(/\/+/g, "/");
}

/** English posts are stored as "<name>.en.md" and share the same URL path as
 *  their Chinese counterpart ("<name>.md"). All producers of post links use
 *  `getPostUrlSlug()` from content-utils, which strips the ".en" marker, so
 *  the plain slug here never needs locale-specific handling. */
export function getPostUrlBySlug(slug: string, lang: string = "zh"): string {
	return lang === "en" ? url(`/en/posts/${slug}/`) : url(`/posts/${slug}/`);
}

export function getArchiveUrl(lang: string = "zh"): string {
	return lang === "en" ? url("/en/archive/") : url("/archive/");
}

export function getTagUrl(tag: string, lang: string = "zh"): string {
	const base = lang === "en" ? "/en/archive/" : "/archive/";
	if (!tag) return url(base);
	return url(`${base}?tag=${encodeURIComponent(tag.trim())}`);
}

export function getCategoryUrl(category: string | null, lang: string = "zh"): string {
	const base = lang === "en" ? "/en/archive/" : "/archive/";
	if (
		!category ||
		category.trim() === "" ||
		category.trim().toLowerCase() ===
			i18n(I18nKey.uncategorized, lang).toLowerCase()
	)
		return url(`${base}?uncategorized=true`);
	return url(`${base}?category=${encodeURIComponent(category.trim())}`);
}

export function getDir(path: string): string {
	const lastSlashIndex = path.lastIndexOf("/");
	if (lastSlashIndex < 0) {
		return "/";
	}
	return path.substring(0, lastSlashIndex + 1);
}

export function url(path: string) {
	return joinUrl("", import.meta.env.BASE_URL, path);
}
