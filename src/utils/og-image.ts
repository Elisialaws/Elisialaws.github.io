import path from "node:path";
import { getImage } from "astro:assets";
import type { ImageMetadata } from "astro";
import bannerImg from "../assets/images/banner.jpg";

let bannerOgPromise: Promise<string> | undefined;

/**
 * Root-relative URL of the site-wide social card image: the banner, resized
 * once per build. Callers make it absolute with `new URL(src, site)`.
 */
export function getBannerOgSrc(): Promise<string> {
	if (!bannerOgPromise) {
		bannerOgPromise = getImage({
			src: bannerImg,
			width: 1200,
			format: "jpeg",
		}).then((image) => image.src);
	}
	return bannerOgPromise;
}

/**
 * Resolve a post cover (the `image` field of a content entry) into an absolute
 * URL usable in meta tags and JSON-LD. Mirrors ImageWrapper's lookup rules:
 * remote URLs are returned as-is, "/..." public paths get the site origin, and
 * everything else is resolved relative to the content directory.
 */
export async function resolvePostCoverUrl(
	src: string | undefined,
	basePath: string,
	site: URL | undefined,
): Promise<string | undefined> {
	if (!src || src.trim() === "") return undefined;
	if (src.startsWith("http://") || src.startsWith("https://")) return src;
	if (src.startsWith("data:")) return undefined;
	if (!site) return undefined;
	if (src.startsWith("/")) return new URL(src, site).href;

	const files = import.meta.glob<ImageMetadata>("../**", { import: "default" });
	const normalized = path
		.normalize(path.join("../", basePath, src))
		.replace(/\\/g, "/");
	const load = files[normalized];
	if (!load) return undefined;

	try {
		const optimized = await getImage({
			src: await load(),
			width: 1200,
			format: "jpeg",
		});
		return new URL(optimized.src, site).href;
	} catch {
		return undefined;
	}
}
