# 汐浅的博客

**主站：<https://xiqian-blog.xiqian-blog.workers.dev> ｜ 镜像（大陆可直连）：<https://elisialaws.github.io>**

个人博客：记录、思考与创造。基于 [Astro 5](https://astro.build/) + [Fuwari](https://github.com/saicaca/fuwari) 主题深度定制，部署在 Cloudflare Workers。

## 特性

- **中英双语**：中文在 `/`，英文在 `/en/`；导航栏「中 | EN」开关在同一篇文章的中英版本间精确互跳（文件名配对：`xxx.md` ↔ `xxx.en.md`，两版 URL 相同路径）
- **全文搜索**：构建时生成 [Pagefind](https://pagefind.app/) 双语索引
- **阅读量统计**：Worker + D1 自建的轻量计数器（`GET /api/views/<slug>`），中英同篇文章合并计数，同一会话内不重复计数
- **明暗主题**：亮色 / 暗色 / 跟随系统（点击式下拉），主题色可调
- **作品集**：`/projects` 与 `/en/projects`（数据写在页面数组里，直接编辑即可）
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
| `src/pages/projects.astro`、`src/pages/en/projects.astro` | 作品集数据 |
| `src/assets/images/` | 横幅（`banner.jpg`）与头像（`avatar.jpg`） |
| `src/layouts/Layout.astro` | 全局脚本（语言开关同步、阅读量填充、swup 钩子） |
| `worker.ts`、`schema.sql` | 阅读量计数（Cloudflare Worker + D1） |
| `wrangler.jsonc` | Cloudflare Workers 部署配置 |

## 许可

- 主题代码来自 [Fuwari](https://github.com/saicaca/fuwari)，MIT License
- 站点内容（文章、图片）版权归作者所有
- 首页横幅插画版权归 [SAKIMICHAN](https://www.patreon.com/sakimichan)
