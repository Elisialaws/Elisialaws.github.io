// src/utils/trending.mjs 的类型声明（实现见同名 .mjs）
export type TrendingRepo = {
	owner: string;
	name: string;
	fullName: string;
	url: string;
	description: string;
	language: string;
	stars: number;
	forks: number;
	gained: number;
};

export type TrendingPeriod = "daily" | "weekly" | "monthly";

export type TrendingLabels = {
	unit?: string;
	empty?: string;
	stars?: string;
	forks?: string;
};

export declare const TRENDING_SOURCE: string;
export declare const TRENDING_PERIODS: TrendingPeriod[];
export declare const TRENDING_LIMIT: number;

export declare function parseTrendingArticle(
	block: string,
): TrendingRepo | null;
export declare function parseTrendingHtml(
	html: string,
	limit?: number,
): TrendingRepo[];
export declare function fetchTrendingPeriod(
	period: TrendingPeriod,
	options?: { limit?: number; timeout?: number; query?: string },
): Promise<TrendingRepo[]>;
export declare function renderTrendingRows(
	items: TrendingRepo[],
	labels?: TrendingLabels,
): string;
