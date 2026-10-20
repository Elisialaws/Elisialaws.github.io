import type { AUTO_MODE, DARK_MODE, LIGHT_MODE } from "@constants/constants";

export type SiteConfig = {
	title: string;
	subtitle: string;
	/** Optional English title/subtitle, shown on /en/ pages */
	titleEn?: string;
	subtitleEn?: string;

	lang:
		| "en"
		| "zh_CN"
		| "zh_TW"
		| "ja"
		| "ko"
		| "es"
		| "th"
		| "vi"
		| "tr"
		| "id";

	themeColor: {
		hue: number;
		fixed: boolean;
	};
	banner: {
		enable: boolean;
		src: string;
		position?: "top" | "center" | "bottom";
		credit: {
			enable: boolean;
			text: string;
			url?: string;
		};
	};
	toc: {
		enable: boolean;
		depth: 1 | 2 | 3;
	};

	favicon: Favicon[];
};

export type Favicon = {
	src: string;
	theme?: "light" | "dark";
	sizes?: string;
};

export enum LinkPreset {
	Home = 0,
	Archive = 1,
	About = 2,
	Projects = 3,
}

export type NavBarLink = {
	name: string;
	url: string;
	external?: boolean;
};

export type NavBarConfig = {
	links: (NavBarLink | LinkPreset)[];
};

export type ProfileConfig = {
	avatar?: string;
	name: string;
	bio?: string;
	/** Optional English bio, shown on /en/ pages */
	bioEn?: string;
	links: {
		name: string;
		url: string;
		icon: string;
	}[];
};

export type LicenseConfig = {
	enable: boolean;
	name: string;
	url: string;
};

export type LIGHT_DARK_MODE =
	| typeof LIGHT_MODE
	| typeof DARK_MODE
	| typeof AUTO_MODE;

export type BlogPostData = {
	body: string;
	title: string;
	published: Date;
	description: string;
	tags: string[];
	draft?: boolean;
	image?: string;
	category?: string;
	prevTitle?: string;
	prevSlug?: string;
	nextTitle?: string;
	nextSlug?: string;
};

export type ExpressiveCodeConfig = {
	theme: string;
};

/**
 * Giscus 评论配置（基于 GitHub Discussions）。
 * 取值说明见 https://giscus.app —— 在页面里选好仓库和分类后，
 * 复制生成的 data-repo-id / data-category-id 填到这里即可。
 */
export type GiscusConfig = {
	/** GitHub 仓库，形如 "owner/repo"（必须是公开仓库） */
	repo: string;
	/** 仓库的 node id，形如 "R_kgDOxxxxxx" */
	repoId: string;
	/** 讨论分类名称，仅用于显示 */
	category: string;
	/** 讨论分类 id，形如 "DIC_kwDOxxxxxx" */
	categoryId: string;
	/** 页面与讨论的映射方式，博客用 "pathname" 最稳 */
	mapping: "pathname" | "url" | "title" | "og:title" | "specific";
	/** 严格标题匹配，配合 mapping=title 时更准 */
	strict?: boolean;
	/** 是否开启表情回应 */
	reactionsEnabled?: boolean;
	/** 是否向父窗口发送讨论元数据 */
	emitMetadata?: boolean;
	/** 评论框位置 */
	inputPosition?: "top" | "bottom";
	/** 界面语言，中文站点用 "zh-CN" */
	lang?: string;
	/** 懒加载：滚动到评论区附近才加载 iframe */
	loading?: "lazy" | "eager";
};

export type CommentConfig = {
	enable: boolean;
	giscus: GiscusConfig;
};
