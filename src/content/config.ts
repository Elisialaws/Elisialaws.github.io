import { defineCollection, z } from "astro:content";

const postsCollection = defineCollection({
	schema: z.object({
		title: z.string(),
		published: z.date(),
		updated: z.date().optional(),
		draft: z.boolean().optional().default(false),
		description: z.string().optional().default(""),
		image: z.string().optional().default(""),
		tags: z.array(z.string()).optional().default([]),
		category: z.string().optional().nullable().default(""),
		lang: z.string().optional().default(""),
		// NOTE: do not add a frontmatter `slug` field here. Astro 5 legacy
		// collections use the frontmatter slug as the entry ID, so a Chinese
		// "<name>.md" and its English "<name>.en.md" would overwrite each other
		// in the content store. Translations are paired by file name instead:
		// "<name>.md" ↔ "<name>.en.md" (the ".en" is stripped from URLs).

		/* For internal use */
		prevTitle: z.string().default(""),
		prevSlug: z.string().default(""),
		nextTitle: z.string().default(""),
		nextSlug: z.string().default(""),
	}),
});
const specCollection = defineCollection({
	schema: z.object({}),
});

/**
 * 论文集合：在 src/content/papers/ 下新建 <slug>.md 即可添加一篇论文。
 * 排序按 year 倒序，同一年按 featured 优先、再按标题。
 */
const papersCollection = defineCollection({
	schema: z.object({
		title: z.string(),
		/** 作者列表，按论文署名顺序；本人可用 "名字*" 标注通讯作者 */
		authors: z.array(z.string()).default([]),
		/** 期刊/会议全称或缩写，如 "NeurIPS 2026"、"IEEE TPAMI" */
		venue: z.string().default(""),
		year: z.number().int(),
		type: z
			.enum(["conference", "journal", "workshop", "preprint", "thesis"])
			.default("conference"),
		status: z
			.enum(["published", "accepted", "under-review", "preprint", "in-prep"])
			.default("published"),
		abstract: z.string().default(""),
		tags: z.array(z.string()).default([]),
		links: z
			.object({
				pdf: z.string().optional(),
				doi: z.string().optional(),
				arxiv: z.string().optional(),
				code: z.string().optional(),
				slides: z.string().optional(),
				poster: z.string().optional(),
				project: z.string().optional(),
			})
			.default({}),
		/** 留空则按 第一作者姓 + 年份 + 标题首词 自动生成 */
		bibtex: z.string().optional(),
		featured: z.boolean().default(false),
		draft: z.boolean().default(false),
	}),
});

export const collections = {
	posts: postsCollection,
	spec: specCollection,
	papers: papersCollection,
};
