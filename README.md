# 汐浅的博客

**主站：<https://xiqian-blog.xiqian-blog.workers.dev> ｜ 镜像（大陆可直连）：<https://elisialaws.github.io>**

个人博客：记录、思考与创造。基于 [Astro 5](https://astro.build/) + [Fuwari](https://github.com/saicaca/fuwari) 主题深度定制，部署在 Cloudflare Workers。

## 特性

- **中英双语**：中文在 `/`，英文在 `/en/`；导航栏「中 | EN」开关在同一篇文章的中英版本间精确互跳（文件名配对：`xxx.md` ↔ `xxx.en.md`，两版 URL 相同路径）
- **全文搜索**：构建时生成 [Pagefind](https://pagefind.app/) 双语索引
- **评论**：[Giscus](https://giscus.app/)（数据存在 GitHub Discussions 里，无后端、无广告），跟随站点亮/暗主题切换
- **阅读量统计**：Worker + D1 自建的轻量计数器（`GET /api/views/<slug>`），中英同篇文章合并计数，同一会话内不重复计数
- **明暗主题**：亮色 / 暗色 / 跟随系统（点击式下拉），主题色可调
- **作品集**：`/projects` 与 `/en/projects`（数据写在页面数组里，直接编辑即可）
- **论文**：`/papers` 与 `/en/papers`，按年份分组，支持摘要折叠、外部链接与一键复制 BibTeX（内容放 `src/content/papers/`）
- **GitHub 趋势**：`/trending` 与 `/en/trending`，今日 / 本周 / 本月三档榜单。首屏用构建快照（`src/data/github-trending.json`，构建前由 `scripts/fetch-trending.mjs` 抓取），打开页面后再向 Worker 的 `GET /api/trending` 要实时数据并重绘，边缘缓存 1 小时 —— 所以 Cloudflare 那份不用重新部署也会是最新的；GitHub Pages 没有 Worker，退回每日定时构建的快照
- 响应式布局、RSS、站点地图、自定义双语 404 页

## 本地开发

```powershell
pnpm install      # 依赖（本项目强制使用 pnpm）
pnpm dev          # 开发服务器 http://localhost:4321
pnpm check        # 类型检查
pnpm build        # 构建（含 Pagefind 搜索索引）
pnpm preview      # 预览构建产物
```

> 搜索只在构建产物（`pnpm preview` 或线上）中可用；阅读量计数依赖线上 Worker，本地会隐藏。

## 写作

```powershell
pnpm new-post my-post   # 新建文章 → src/content/posts/my-post.md
```

- 英文版文件名加 `.en` 后缀（`my-post.en.md`），frontmatter 里写 `lang: en`；两版 URL 分别为 `/posts/my-post/` 与 `/en/posts/my-post/`，语言开关会根据文件名自动精确配对
- **不要**在 frontmatter 写 `slug` 字段（会与 `.en` 配对冲突，详见开发笔记）
- 文章封面图放 `src/content/posts/<目录>/`，frontmatter 的 `image` 字段引用

## 评论（Giscus）

评论由 Giscus 驱动，数据保存在仓库的 GitHub Discussions 里，站点本身不需要后端。配置在 `src/config.ts` 的 `commentConfig`，组件是 `src/components/Comments.astro`（挂在 `src/pages/posts/[...slug].astro` 与英文版同一位置）。

首次启用需要三步（只需做一次，本站已完成）：

1. 仓库 **Settings → General → Features** 勾选 **Discussions**
2. 给仓库安装 Giscus App：<https://github.com/apps/giscus>
3. 打开 <https://giscus.app>，仓库填 `Elisialaws/Elisialaws.github.io`，选好分类后把 `data-category-id` 填到 `commentConfig.giscus.categoryId`

当前取的是 Discussions 默认分类 `General`（`categoryId` = `DIC_kwDOVObTY84DJLSt`）。想更干净的话，可以在 GitHub 新建一个 **Announcements** 类型的 `Comments` 分类，再用 giscus.app 给出的新 id 替换这两项。`categoryId` 为空时，文章页评论区会显示一行配置提示，不会报错。映射方式用 `pathname`：中英文文章路径不同，各自有独立讨论串。

## 论文

论文页在 `/papers/` 与 `/en/papers/`，数据来自内容集合 `src/content/papers/`，一篇论文一个 Markdown 文件。`src/content/papers/example-paper.md` 是模板（`draft: true`，不会出现在线上），复制改名后填字段即可：

```yaml
title: "论文标题"
authors: ["汐浅", "Co-author Name"]   # 按署名顺序
venue: "NeurIPS"                      # 会议/期刊名，可留空
year: 2026
type: conference                      # conference | journal | workshop | preprint | thesis
status: published                     # published | accepted | under-review | preprint | in-prep
featured: true                        # 显示「代表作」标记，同年内优先排序
abstract: >-                          # 卡片里折叠显示
  摘要正文……
links:
  pdf: "https://..."
  doi: "https://doi.org/..."
  arxiv: "2601.00001"                 # 只填编号，会自动拼成 arXiv:xxx
  code: "https://github.com/..."
  slides: / poster: / project:        # 同样可选
tags: ["LLM", "Systems"]
draft: false
```

- 排序：年份倒序 → `featured` 优先 → 标题；页面按年份自动分组
- BibTeX 由 frontmatter 自动生成（引用键 = 第一作者姓 + 年份 + 标题首个实词）；想手写就在 `bibtex:` 里填整段，会优先使用
- 中文页与英文页共用同一份数据，只有界面文案区分语种

每篇论文还有独立详情页 `/papers/<文件名>/`（英文 `/en/papers/<文件名>/`），列表页点标题进入。详情页除了摘要、笔记与 BibTeX，还会输出 Google Scholar 抓取所需的 `citation_title`、`citation_author`、`citation_publication_date`、`citation_conference_title` / `citation_journal_title`、`citation_doi`、`citation_pdf_url`、`citation_arxiv_id`、`citation_abstract`，以及 schema.org 的 `ScholarlyArticle` 结构化数据。论文能不能被学术检索收录，靠的是这一组标签，而不是页面排版本身。

## 标签

标签不需要维护。侧栏标签云、`/tags/` 总览、以及每个标签的独立页面 `/tags/<slug>/`（英文 `/en/tags/<slug>/`）全部在构建时按文章 frontmatter 的 `tags` 生成。

- slug 规则：小写 → 空白与下划线转连字符 → 只保留字母、数字、中文以及 `+ . -`。所以 `AI Infra` → `ai-infra`，`C++` → `c++`，`Node.js` → `node.js`
- 同一 slug 的不同写法会合并（`AI Infra` 与 `ai-infra` 是同一个页面），展示名取出现最多的那个
- 归档页的 `?tag=` 过滤还在，但那只是站内筛选、不可索引；可分享、可被收录的是上面的落地页
- 中英文章的标签各自独立：中文「前端」与英文 `frontend` 是两个不同页面，不会互相声明 hreflang——它们本来就不是同一页的两种语言版本

## GitHub 趋势

榜单在**构建时**抓取，写入 `src/data/github-trending.json`，页面直接读快照——没有运行时请求、不受 GitHub API 限流影响。

```powershell
pnpm fetch-trending              # 手动更新一次快照
node scripts/fetch-trending.mjs --limit=30   # 自定义条数
$env:SKIP_TRENDING=1; pnpm build # 跳过抓取，沿用现有快照（离线时用）
```

- `pnpm build` 前会自动跑一次（`prebuild`），所以每次部署都拿到最新榜单
- 数据源是 `https://github.com/trending` 的 HTML：GitHub 没有官方 trending 接口，Search API 只能按总星数排序，和「当下在涨」不是一回事
- 抓取失败时脚本只打印警告并保留旧快照，不会中断构建；连续失败也不会把文件写空
- 每天 01:17 UTC（北京时间 09:17）由 `.github/workflows/refresh-trending.yml` 自动重建并发布一次，所以即使很久不写文章，榜单也会保持新鲜。该工作流只发布、不回写仓库（仓库里的快照旧一点不影响线上，下次任何构建的 `prebuild` 都会重新抓）
- 想让它顺带更新 Cloudflare Workers 那份，在仓库 Secrets 里加上 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`，工作流最后一步会自动部署；没配就跳过

## 双语与 SEO

中文在根目录、英文在 `/en/`；`<name>.md` 与 `<name>.en.md` 共用同一个 URL 段。

- 每页 `<head>` 输出 `canonical` 与 `hreflang`（`zh-CN` / `en` / `x-default`），并且只在目标语种页面真实存在时才声明对方。标签页、未翻译的文章属于「只有一边」的情况，就只声明自身语种
- sitemap 里的 alternate 由 `astro.config.mjs` 的 `serialize` 按 `dist` 实际产物生成。`@astrojs/sitemap` 内置的 i18n 只按路径前缀推断，会把不存在的翻译也声明出来，所以没有用它
- `pnpm build` 末尾会跑 `scripts/check-seo.mjs` 做门禁：sitemap 的 alternate 是否成对、是否指向真实页面、每页是否都有 canonical 与自身语种的 hreflang。有问题直接构建失败
- 单独跑：`pnpm seo:check`（需先构建）

## 部署（Cloudflare Workers，免费套餐）

```powershell
pnpm build
npx wrangler deploy   # 首次需先 npx wrangler login
```

- `wrangler.jsonc` 配置了：静态资源 `./dist` + `worker.ts`（阅读量 API）+ D1 数据库 `xiqian-blog-views`
- 推送 `main` 后 GitHub Actions 会自动构建并发布 GitHub Pages 镜像：<https://elisialaws.github.io/>（大陆可直连；镜像上阅读量计数不可用，会自动隐藏）
- 首次部署前初始化 D1 表：
  ```powershell
  npx wrangler d1 execute xiqian-blog-views --remote --file=./schema.sql
  ```

## 目录速览

| 路径 | 说明 |
| --- | --- |
| `src/config.ts` | 全站配置（标题、横幅、头像、导航、社交链接） |
| `src/content/posts/` | 文章（Markdown） |
| `src/content/spec/` | 关于页（`about.md` / `about.en.md`） |
| `src/content/papers/` | 论文（Markdown，模板见 `example-paper.md`） |
| `src/pages/tags/`、`src/pages/en/tags/` | 标签总览与标签落地页（构建时按 tags 生成） |
| `src/utils/tag-utils.ts` | 标签 slug 规则、落地页数据 |
| `src/pages/papers/[slug].astro` | 论文详情页（citation meta + ScholarlyArticle） |
| `src/data/github-trending.json` | GitHub 趋势快照（由 `scripts/fetch-trending.mjs` 生成） |
| `scripts/fetch-trending.mjs` | 趋势抓取脚本（`pnpm fetch-trending`） |
| `scripts/check-seo.mjs` | 构建后的 hreflang / canonical 自检（`pnpm seo:check`） |
| `.github/workflows/` | `pages.yml` 推送即部署；`refresh-trending.yml` 每天刷新趋势 |
| `src/pages/projects.astro`、`src/pages/en/projects.astro` | 作品集数据 |
| `src/assets/images/` | 横幅（`banner.jpg`）与头像（`avatar.jpg`） |
| `src/layouts/Layout.astro` | 全局脚本（语言开关同步、阅读量填充、swup 钩子） |
| `worker.ts`、`schema.sql` | 阅读量计数（Cloudflare Worker + D1） |
| `wrangler.jsonc` | Cloudflare Workers 部署配置 |

## 许可

- 主题代码来自 [Fuwari](https://github.com/saicaca/fuwari)，MIT License
- 站点内容（文章、图片）版权归作者所有
- 首页横幅插画版权归 [SAKIMICHAN](https://www.patreon.com/sakimichan)
