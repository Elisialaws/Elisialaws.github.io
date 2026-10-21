import I18nKey from "@i18n/i18nKey";
import { DEFAULT_LOCALE, i18n, localePath, type Locale } from "@i18n/translation";
import { LinkPreset, type NavBarLink } from "@/types/config";

/** Build the localized nav link presets for a given site locale */
export function getLinkPresets(
	lang: Locale = DEFAULT_LOCALE,
): { [key in LinkPreset]: NavBarLink } {
	return {
		[LinkPreset.Home]: {
			name: i18n(I18nKey.home, lang),
			url: localePath(lang, "/"),
		},
		[LinkPreset.Archive]: {
			name: i18n(I18nKey.archive, lang),
			url: localePath(lang, "/archive/"),
		},
		[LinkPreset.About]: {
			name: i18n(I18nKey.about, lang),
			url: localePath(lang, "/about/"),
		},
		[LinkPreset.Projects]: {
			name: i18n(I18nKey.projects, lang),
			url: localePath(lang, "/projects/"),
		},
		[LinkPreset.Papers]: {
			name: i18n(I18nKey.papers, lang),
			url: localePath(lang, "/papers/"),
		},
		[LinkPreset.Trending]: {
			name: i18n(I18nKey.trending, lang),
			url: localePath(lang, "/trending/"),
		},
	};
}
