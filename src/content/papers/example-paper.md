---
# 这是一份模板：复制本文件、改名成你的论文 slug，然后填写字段。
# draft: true 时不会出现在线上页面（生产构建会过滤掉），改成 false 才会显示。
title: "示例：一个用于演示版式的论文标题"
authors:
  - "汐浅"
  - "Co-author Name"
venue: "NeurIPS"
year: 2026
type: conference        # conference | journal | workshop | preprint | thesis
status: published       # published | accepted | under-review | preprint | in-prep
featured: true
tags: ["示例标签", "Demo"]
abstract: >-
  这里放摘要。建议控制在 150–250 词，讲清楚问题、方法、结果三件事。
  折叠在卡片里，展开才显示，所以长一点也不会破坏列表的节奏。
  这一段是占位文本，确认版式后可以整份文件删掉。
links:
  pdf: "https://example.com/paper.pdf"
  doi: "https://doi.org/10.0000/example.2026.001"
  arxiv: "2601.00001"
  code: "https://github.com/Elisialaws"
# bibtex: |            # 可选：填了就优先用你写的，留空则按字段自动生成
#   @inproceedings{...}
draft: true
---

正文不会渲染在列表页，摘要请写在 frontmatter 的 abstract 里。
