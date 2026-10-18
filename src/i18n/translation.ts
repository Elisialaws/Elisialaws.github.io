import { siteConfig } from "../config";
import type I18nKey from "./i18nKey";
import { en } from "./languages/en";
import { es } from "./languages/es";
import { id } from "./languages/id";
import { ja } from "./languages/ja";
import { ko } from "./languages/ko";
import { th } from "./languages/th";
import { tr } from "./languages/tr";
import { vi } from "./languages/vi";
import { zh_CN } from "./languages/zh_CN";
import { zh_TW } from "./languages/zh_TW";

export type Translation = {
	[K in I18nKey]: string;
};

const defaultTranslation = en;

const map: { [key: string]: Translation } = {
	es: es,
	en: en,
	zh: zh_CN,
	en_us: en,
	en_gb: en,
	en_au: en,
	zh_cn: zh_CN,
	zh_tw: zh_TW,
	ja: ja,
	ja_jp: ja,
	ko: ko,
	ko_kr: ko,
	th: th,
	th_th: th,
	vi: vi,
	vi_vn: vi,
	id: id,
	tr: tr,
	tr_tr: tr,
};

export function getTranslation(lang: string): Translation {
	return map[lang.toLowerCase()] || defaultTranslation;
}

export function i18n(key: I18nKey, lang?: string): string {
	const l = lang || siteConfig.lang || "en";
	return getTranslation(l)[key];
}

/** Site-level locale used for routing: Chinese has no URL prefix, English lives under /en/ */
export type Locale = "zh" | "en";

export const DEFAULT_LOCALE: Locale = "zh";

/** Normalize an arbitrary language code to one of the site locales */
export function toLocale(lang?: string | null): Locale {
	if (!lang) return DEFAULT_LOCALE;
	const l = lang.toLowerCase();
	if (l === "en" || l.startsWith("en-") || l.startsWith("en_")) return "en";
	if (l === "zh" || l.startsWith("zh-") || l.startsWith("zh_")) return "zh";
	return DEFAULT_LOCALE;
}

/** Detect the locale of the current page from its URL path */
export function getLocaleFromUrl(pathname: string): Locale {
	return /^\/en(\/|$)/.test(pathname) ? "en" : "zh";
}

/** Locale -> value for the <html lang="..."> attribute */
export function localeToHtmlLang(locale: Locale): string {
	return locale === "en" ? "en" : "zh-CN";
}

/** Prefix a root-relative path with the locale prefix ("/archive/" -> "/en/archive/" for en) */
export function localePath(locale: Locale, path: string): string {
	if (locale !== "en") return path;
	if (path === "/" || path === "") return "/en/";
	return `/en${path.startsWith("/") ? path : `/${path}`}`;
}
