import type {
	CommentConfig,
	ExpressiveCodeConfig,
	LicenseConfig,
	NavBarConfig,
	ProfileConfig,
	SiteConfig,
} from "./types/config";
import { LinkPreset } from "./types/config";

export const siteConfig: SiteConfig = {
	title: "汐浅的博客",
	titleEn: "Xiqian's Blog",
	subtitle: "记录、思考与创造",
	subtitleEn: "Notes on coding, thinking and creating",
	lang: "zh_CN", // Default language of the site (lang: 'zh_CN', 'en', ...)
	themeColor: {
		hue: 250, // Default hue for the theme color, from 0 to 360. e.g. red: 0, teal: 200, cyan: 250, pink: 345
		fixed: false, // Hide the theme color picker for visitors
	},
	banner: {
		enable: true,
		src: "assets/images/banner.jpg", // 相对 /src 目录；以 / 开头则是相对 /public
		position: "center", // 相当于 object-position，仅支持 'top' | 'center' | 'bottom'
		credit: {
			enable: true, // 是否显示横幅图片的版权署名
			text: "Art by SAKIMICHAN", // 署名文字
			url: "https://www.patreon.com/sakimichan", // 原作者链接
		},
	},
	toc: {
		enable: true, // Display the table of contents on the right side of the post
		depth: 2, // Maximum heading depth to show in the table, from 1 to 3
	},
	favicon: [
		// Leave this array empty to use the default favicon
		// {
		//   src: '/favicon/icon.png',    // Path of the favicon, relative to the /public directory
		//   theme: 'light',              // (Optional) Either 'light' or 'dark', set only if you have different favicons for light and dark mode
		//   sizes: '32x32',              // (Optional) Size of the favicon, set only if you have favicons of different sizes
		// }
	],
};

export const navBarConfig: NavBarConfig = {
	// About lives in the footer; GitHub is an icon next to the language switch
	links: [LinkPreset.Home, LinkPreset.Archive, LinkPreset.Projects],
};

export const profileConfig: ProfileConfig = {
	avatar: "assets/images/avatar.jpg", // 头像（相对 /src 或 /public 的路径）
	name: "汐浅",
	bio: "你好，我是汐浅。这里记录我的文章、笔记和作品。",
	bioEn: "Hi, I'm Xiqian. I write about code, notes and side projects here.",
	links: [
		{
			name: "GitHub",
			icon: "fa6-brands:github", // Visit https://icones.js.org/ for icon codes
			// You will need to install the corresponding icon set if it's not already included
			// `pnpm add @iconify-json/<icon-set-name>`
			url: "https://github.com/Elisialaws",
		},
	],
};

export const licenseConfig: LicenseConfig = {
	enable: true,
	name: "CC BY-NC-SA 4.0",
	url: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
};

export const expressiveCodeConfig: ExpressiveCodeConfig = {
	// Note: Some styles (such as background color) are being overridden, see the astro.config.mjs file.
	// Please select a dark theme, as this blog theme currently only supports dark background color
	theme: "github-dark",
};

/**
 * 评论区（Giscus，数据存在 GitHub Discussions 里）
 *
 * 启用前需要在 GitHub 上做三件事：
 * 1. 仓库 Settings → General → Features 勾选 Discussions
 * 2. 给仓库安装 Giscus App：https://github.com/apps/giscus
 * 3. 打开 https://giscus.app ，填入仓库 Elisialaws/Elisialaws.github.io，
 *    分类选一个（例如新建 Comments），把页面生成的
 *    data-category-id 复制到下面的 categoryId 里
 *
 * repoId 已经填好；categoryId 留空时文章页会显示一行配置提示，不会报错。
 */
export const commentConfig: CommentConfig = {
	enable: true,
	giscus: {
		repo: "Elisialaws/Elisialaws.github.io",
		repoId: "R_kgDOVObTYw",
		category: "Comments",
		categoryId: "",
		// mapping 用 pathname：中英文文章路径不同，各自拥有独立讨论串
		mapping: "pathname",
		strict: false,
		reactionsEnabled: true,
		emitMetadata: false,
		inputPosition: "top",
		lang: "zh-CN",
		loading: "lazy",
	},
};

