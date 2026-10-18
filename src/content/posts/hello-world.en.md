---
title: Hello, World
published: 2026-10-18
description: The first post of this blog — what I plan to write about, and how the language switch works.
image: ''
tags: [Notes, Blog]
category: Life
draft: false
lang: en
---

Welcome to Xiqian's Blog!

This is the very first post. The reason for building this blog is simple: I wanted a quiet corner of the internet that belongs to me, to keep notes and thoughts.

## What I'll write about

- **Tech notes**: pitfalls, tools I like, code worth reading
- **Life notes**: thoughts and observations from daily life
- **Projects**: small things I'm building, collected in the [portfolio](/en/projects/)

## About the two languages

This blog ships with a Chinese and an English version:

- Chinese lives at `/`, English lives at `/en/`
- The button in the top-right corner switches between the two versions of the current page
- If a post has no translation yet, the button takes you to the other language's home page

## A tiny code sample

Tinkering with a blog always involves little scripts, like listing English posts:

```bash
for f in *.en.md; do
  echo "English post: $f"
done
```

> Slow is smooth, smooth is fast.

More posts are on the way. Say hi on the [about page](/en/about/) if you'd like to get in touch.
