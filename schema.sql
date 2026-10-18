-- Page-view counter for 汐浅的博客 (Cloudflare D1 database: xiqian-blog-views)
-- Apply remotely:  npx wrangler d1 execute xiqian-blog-views --remote --file=./schema.sql
-- Apply locally:   npx wrangler d1 execute xiqian-blog-views --local  --file=./schema.sql
CREATE TABLE IF NOT EXISTS views (
	slug TEXT PRIMARY KEY,
	count INTEGER NOT NULL DEFAULT 0
);
