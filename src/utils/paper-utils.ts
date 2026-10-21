import { getCollection, type CollectionEntry } from "astro:content";
import { getLocaleFromUrl, type Locale } from "@i18n/translation";
import { url } from "@utils/url-utils";

export type Paper = CollectionEntry<"papers">;

/** 论文外链的展示顺序与图标（列表页与详情页共用） */
export const PAPER_LINK_ORDER = [
	"pdf",
	"doi",
	"arxiv",
	"code",
	"slides",
	"poster",
	"project",
] as const;

export const PAPER_LINK_ICONS: Record<string, string> = {
	pdf: "material-symbols:picture-as-pdf-outline-rounded",
	doi: "material-symbols:link-rounded",
	arxiv: "material-symbols:article-outline-rounded",
	code: "material-symbols:code-rounded",
	slides: "material-symbols:slideshow-outline-rounded",
	poster: "material-symbols:image-outline-rounded",
	project: "material-symbols:folder-open-outline-rounded",
};

/** 论文的 URL 段：frontmatter 没有 slug 字段，直接用文件名 */
export function getPaperSlug(paper: Paper): string {
	return paper.id.replace(/\.(md|mdx)$/i, "");
}

/** 单篇论文详情页地址（中英共用同一份数据，前缀随语种） */
export function getPaperUrl(paper: Paper, lang: Locale = "zh"): string {
	const base = lang === "en" ? "/en/papers/" : "/papers/";
	return url(`${base}${getPaperSlug(paper)}/`);
}

/** 该 slug 的论文是否存在（论文不分语种，中英页面同源） */
export async function paperSlugExists(slug: string): Promise<boolean> {
	const papers = await getSortedPapers();
	return papers.some((paper) => getPaperSlug(paper) === slug);
}

/** 论文列表：生产环境过滤 draft，按 年份倒序 → featured → 标题 排序 */
export async function getSortedPapers(): Promise<Paper[]> {
	const all = await getCollection("papers", ({ data }) => {
		if (import.meta.env.PROD && data.draft === true) return false;
		return true;
	});
	return all.sort((a, b) => {
		if (a.data.year !== b.data.year) return b.data.year - a.data.year;
		if (a.data.featured !== b.data.featured) return a.data.featured ? -1 : 1;
		return a.data.title.localeCompare(b.data.title);
	});
}

/** 按年份分组，年份从新到旧 */
export function groupByYear(papers: Paper[]): { year: number; papers: Paper[] }[] {
	const map = new Map<number, Paper[]>();
	for (const p of papers) {
		const list = map.get(p.data.year) ?? [];
		list.push(p);
		map.set(p.data.year, list);
	}
	return [...map.entries()]
		.sort((a, b) => b[0] - a[0])
		.map(([year, list]) => ({ year, papers: list }));
}

const BIBTEX_TYPE: Record<Paper["data"]["type"], string> = {
	conference: "inproceedings",
	journal: "article",
	workshop: "inproceedings",
	preprint: "misc",
	thesis: "phdthesis",
};

/** 生成引用键：第一作者姓 + 年份 + 标题首个实词 */
export function makeBibKey(paper: Paper): string {
	const first = paper.data.authors[0] ?? "anon";
	const surname = first.replace(/[*†\d]/g, "").trim().split(/\s+/).pop() ?? "anon";
	const word =
		paper.data.title
			.split(/\s+/)
			.map((w) => w.replace(/[^A-Za-z]/g, ""))
			.find((w) => w.length > 2) ?? "paper";
	return `${surname}${paper.data.year}${word}`.toLowerCase();
}

/** 由 frontmatter 自动生成 BibTeX；若填了 bibtex 字段则直接用 */
export function getBibtex(paper: Paper): string {
	if (paper.data.bibtex?.trim()) return paper.data.bibtex.trim();

	const { title, authors, venue, year, type, links } = paper.data;
	const entryType = BIBTEX_TYPE[type];
	const key = makeBibKey(paper);
	const fields: string[] = [
		`  title = {${title}}`,
		`  author = {${authors.join(" and ")}}`,
	];
	if (venue) {
		fields.push(`  ${type === "journal" ? "journal" : "booktitle"} = {${venue}}`);
	}
	fields.push(`  year = {${year}}`);
	if (type === "preprint" && links.arxiv) {
		fields.push(`  howpublished = {arXiv:${links.arxiv}}`);
	}
	if (links.doi) fields.push(`  doi = {${links.doi}}`);
	if (links.pdf) fields.push(`  url = {${links.pdf}}`);
	return `@${entryType}{${key},\n${fields.join(",\n")}\n}`;
}

export type PaperLabels = {
	papers: string;
	papersIntro: string;
	emptyTitle: string;
	emptyHint: string;
	abstract: string;
	bibtex: string;
	copied: string;
	copyFailed: string;
	links: Record<string, string>;
	types: Record<string, string>;
	statuses: Record<string, string>;
	featured: string;
	/* 单篇详情页 */
	backToPapers: string;
	authorsLabel: string;
	venueLabel: string;
	citation: string;
	notes: string;
	copyCitation: string;
};

const zhLabels: PaperLabels = {
	papers: "论文",
	papersIntro: "我的研究成果与发表记录，点击标题或 PDF 可查看原文。",
	emptyTitle: "论文正在整理中",
	emptyHint: "先把最有代表性的几篇挂上来，比一份冗长的清单更有说服力。",
	abstract: "摘要",
	bibtex: "BibTeX",
	copied: "已复制",
	copyFailed: "已选中，按 Ctrl+C 复制",
	links: {
		pdf: "PDF",
		doi: "DOI",
		arxiv: "arXiv",
		code: "代码",
		slides: "幻灯片",
		poster: "海报",
		project: "项目页",
	},
	types: {
		conference: "会议",
		journal: "期刊",
		workshop: "Workshop",
		preprint: "预印本",
		thesis: "学位论文",
	},
	statuses: {
		published: "已发表",
		accepted: "已录用",
		"under-review": "在审",
		preprint: "预印本",
		"in-prep": "撰写中",
	},
	featured: "代表作",
	backToPapers: "全部论文",
	authorsLabel: "作者",
	venueLabel: "发表于",
	citation: "引用信息",
	notes: "笔记",
	copyCitation: "复制引用",
};

const enLabels: PaperLabels = {
	papers: "Papers",
	papersIntro:
		"My research output and publication record. Click a title or the PDF link to read the original.",
	emptyTitle: "Papers are being organised",
	emptyHint:
		"A handful of representative papers says more than an exhaustive list.",
	abstract: "Abstract",
	bibtex: "BibTeX",
	copied: "Copied",
	copyFailed: "Selected — press Ctrl+C to copy",
	links: {
		pdf: "PDF",
		doi: "DOI",
		arxiv: "arXiv",
		code: "Code",
		slides: "Slides",
		poster: "Poster",
		project: "Project",
	},
	types: {
		conference: "Conference",
		journal: "Journal",
		workshop: "Workshop",
		preprint: "Preprint",
		thesis: "Thesis",
	},
	statuses: {
		published: "Published",
		accepted: "Accepted",
		"under-review": "Under review",
		preprint: "Preprint",
		"in-prep": "In preparation",
	},
	featured: "Selected",
	backToPapers: "All papers",
	authorsLabel: "Authors",
	venueLabel: "Published in",
	citation: "Citation",
	notes: "Notes",
	copyCitation: "Copy citation",
};

/** 页面文案：按语种取，中英各一套 */
export function getPaperLabelsByLocale(locale: Locale): PaperLabels {
	return locale === "en" ? enLabels : zhLabels;
}

/** 页面文案：按 URL 判断语种 */
export function getPaperLabels(pathname: string): PaperLabels {
	return getPaperLabelsByLocale(getLocaleFromUrl(pathname));
}
