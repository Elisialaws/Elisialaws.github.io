import { getLocaleFromUrl, localePath, type Locale } from "@i18n/translation";
import { findPostBySlug } from "@utils/content-utils";
import { url } from "@utils/url-utils";

/** Route segments of static pages that exist in both languages */
const STATIC_ROUTE_SEGMENTS = ["archive", "about", "projects"];

/** Strip the locale prefix and normalize to a trailing-slash path */
function normalizePath(pathname: string, locale: Locale): string {
	let p = pathname;
	if (locale === "en") {
		p = p.replace(/^\/en(?=\/|$)/, "");
		if (p === "") p = "/";
	}
	if (p !== "/" && !p.endsWith("/")) p += "/";
	return p;
}

/** Given the canonical (unprefixed) path of the current page, resolve where
 *  the given target locale version of that page lives. Falls back to the
 *  target locale home page when no counterpart exists. */
async function resolveTargetPath(
	path: string,
	target: Locale,
): Promise<{ path: string; paired: boolean }> {
	// Home page or pagination pages: "/" or "/2/"
	if (path === "/" || /^\/\d+\/$/.test(path)) {
		return { path: localePath(target, path), paired: true };
	}

	// Posts: "/posts/<slug>/"
	const postMatch = path.match(/^\/posts\/(.+)\/$/);
	if (postMatch) {
		const slug = decodeURIComponent(postMatch[1]);
		if (await findPostBySlug(slug, target)) {
			return { path: localePath(target, `/posts/${slug}/`), paired: true };
		}
		return { path: localePath(target, "/"), paired: false };
	}

	// Static pages: archive / about / projects
	const seg = path.replace(/^\//, "").split("/")[0];
	if (STATIC_ROUTE_SEGMENTS.includes(seg)) {
		return { path: localePath(target, `/${seg}/`), paired: true };
	}

	// Unknown page: send to the home page of the target locale
	return { path: localePath(target, "/"), paired: false };
}

export type LangSwitchSide = {
	/** Root-relative URL of this language's version of the current page (already base-aware) */
	url: string;
	/** Tooltip text / aria-label for this side's segment */
	title: string;
	/** Whether this side is the real counterpart page (vs. home page fallback) */
	paired: boolean;
};

export type LangSwitchInfo = {
	/** Locale of the page the visitor is on */
	current: Locale;
	/** Chinese side of the 中/EN switch */
	zh: LangSwitchSide;
	/** English side of the 中/EN switch */
	en: LangSwitchSide;
};

export async function getLangSwitchInfo(pathname: string): Promise<LangSwitchInfo> {
	const current = getLocaleFromUrl(pathname);
	const canonical = normalizePath(pathname, current);
	const [zhResolved, enResolved] = await Promise.all([
		resolveTargetPath(canonical, "zh"),
		resolveTargetPath(canonical, "en"),
	]);

	// Tooltip for the segment of the language the visitor is already on
	const currentTitle =
		current === "zh" ? "当前语言：中文" : "Current language: English";

	// Tooltip for the other-language segment, worded in the visitor's language
	const otherSide = current === "zh" ? enResolved : zhResolved;
	let otherTitle: string;
	if (current === "zh") {
		otherTitle = otherSide.paired
			? "查看英文版"
			: "暂无英文版，将前往英文首页";
	} else {
		otherTitle = otherSide.paired
			? "View the Chinese version"
			: "No Chinese version yet, going to the Chinese home page";
	}

	return {
		current,
		zh: {
			url: url(zhResolved.path),
			title: current === "zh" ? currentTitle : otherTitle,
			paired: zhResolved.paired,
		},
		en: {
			url: url(enResolved.path),
			title: current === "en" ? currentTitle : otherTitle,
			paired: enResolved.paired,
		},
	};
}

/** Root-relative URLs of the zh / en versions of the current page, for hreflang tags */
export async function getAlternateUrls(
	pathname: string,
): Promise<Record<Locale, string>> {
	const current = getLocaleFromUrl(pathname);
	const canonical = normalizePath(pathname, current);
	const [zhTarget, enTarget] = await Promise.all([
		resolveTargetPath(canonical, "zh"),
		resolveTargetPath(canonical, "en"),
	]);
	return {
		zh: url(zhTarget.path),
		en: url(enTarget.path),
	};
}
