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
export const collections = {
	posts: postsCollection,
	spec: specCollection,
};
