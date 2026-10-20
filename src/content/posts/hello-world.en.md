---
title: "Hello, World: One Line from Source to Screen"
published: 2026-10-18
updated: 2026-10-20
description: Taking print("你好，世界") apart — how CPython compiles it to bytecode, how the bytecode reaches write(1), how five characters become fifteen UTF-8 bytes, how the terminal paints them, and where the browser's hello world goes instead.
image: ''
tags: [Python, Internals, Frontend]
category: Tech
draft: false
lang: en
---

`print("hello, world")` is the first line most of us ever wrote. It is short enough to need no explanation, yet long enough to travel through an entire computer: a compiler, a virtual machine, the C runtime, a system call, an encoding table, a font, a rasteriser.

So let's follow that line all the way down.

## 1. Source code is not a program

What we write is just text. The first thing an interpreter does is work out the structure of that text:

1. Lexing: chop the character stream into tokens (`NAME print`, `OP (`, `STRING "hello, world"`)
2. Parsing: assemble the tokens into an AST according to the grammar
3. Compilation: turn the AST into bytecode
4. Execution: run the bytecode one instruction at a time

In CPython the first two steps are the PEG parser's job; steps three and four are two very different things — bytecode is *instructions*, the interpreter loop is the *CPU*.

Python ships `ast`, so we can look at the tree directly:

```python
import ast
print(ast.dump(ast.parse('print("hello, world")'), indent=2))
```

```text
Module(
  body=[
    Expr(
      value=Call(
        func=Name(id='print', ctx=Load()),
        args=[Constant(value='hello, world')],
        keywords=[]))],
  type_ignores=[])
```

One expression statement, containing one function call, with exactly one argument: a string constant.

## 2. Compiled to bytecode

The AST is not what runs. Bytecode generated from the AST is. `compile()` plus `dis` shows it:

```python
import dis

code = compile('print("hello, world")', "<string>", "exec")
dis.dis(code)
```

Output on Python 3.13:

```text
  0           RESUME                   0

  1           LOAD_NAME                0 (print)
              PUSH_NULL
              LOAD_CONST               0 ('hello, world')
              CALL                     1
              POP_TOP
              RETURN_CONST             1 (None)
```

A few details worth noticing:

- `LOAD_CONST` means the string was placed in the constant pool at compile time (`code.co_consts == ('hello, world', None)`) — nothing is rebuilt at run time
- `LOAD_NAME` rather than `LOAD_GLOBAL`, because this code sits at module level and name lookup starts in the local namespace
- `PUSH_NULL` (new in 3.11) pushes a NULL marker meaning "this call is not a method call", which saves a runtime type check
- `RETURN_CONST` (new in 3.12) returns a constant without the push-then-return dance

None of these instructions know anything about text encoding. The string is just an object reference; the encoding question is deferred until the data actually has to leave the process.

## 3. From CALL to write(1)

`CALL 1` ends up in the C function `builtin_print`, whose logic boils down to:

```c
for (each arg) {
    PyFile_WriteObject(arg, sys.stdout, Py_PRINT_RAW);
}
PyFile_WriteString("\n", sys.stdout);
if (flush) PyFile_Flush(sys.stdout);
```

`print` does not write to the screen. It writes to a file object, `sys.stdout`, which has three layers:

```text
TextIOWrapper  →  str/bytes conversion, encoding and newline handling
BufferedWriter →  batches data before handing it to the kernel
FileIO         →  the actual write(2) system call
```

Only the bottom layer is `write(1, buf, n)` — hand some bytes to the kernel, 1 being the file descriptor for standard output. Past this point the process no longer cares about characters, only bytes.

### Buffering decides what you actually see

How `BufferedWriter` behaves depends on what it is attached to:

| Destination | Buffering | Consequence |
| --- | --- | --- |
| Terminal (tty) | Line buffered | Flushes on newline — matches intuition |
| Pipe / file | Block buffered (often 8 KiB) | Not flushed until full — looks "stuck" |
| `python -u` or `PYTHONUNBUFFERED=1` | Unbuffered | Every write hits the kernel; slower but immediate |

So these two commands behave differently:

```bash
python -c 'print("hello, world")' | cat          # block buffered, flushed on exit
python -u -c 'print("hello, world")' | cat       # unbuffered, readable immediately
```

When a logging service is killed with `kill -9` and loses its last few lines, this is why: the data was still sitting in a user-space buffer. `print(..., flush=True)` is the targeted fix.

:::tip
To see the actual system calls, run `strace -e write python3 -c 'print("hello, world")'` on Linux, or `dtruss` on macOS. The byte count is exactly 13: 12 UTF-8 bytes plus the newline.
:::

## 4. Where the bytes come from

`"你好，世界"` — "hello, world" in Chinese — is five characters:

```python
s = "你好，世界"
print(len(s))                   # 5  — Unicode code points
print(len(s.encode("utf-8")))    # 15 — bytes
print([hex(ord(c)) for c in s])
```

```text
['0x4f60', '0x597d', '0xff0c', '0x4e16', '0x754c']
```

Unfolded through UTF-8's three-byte template `1110xxxx 10xxxxxx 10xxxxxx`:

| Char | Code point | UTF-8 bytes |
| --- | --- | --- |
| 你 | U+4F60 | `E4 BD A0` |
| 好 | U+597D | `E5 A5 BD` |
| ， | U+FF0C | `EF BC 8C` |
| 世 | U+4E16 | `E4 B8 96` |
| 界 | U+754C | `E7 95 8C` |

Five characters become fifteen bytes — a 3× expansion. That is why "character count" and "file size" never line up for CJK text, and why truncating a string by bytes can split a character in half: cut `E4 BD` before its trailing `A0` and you get mojibake. To truncate safely, cut on code points or grapheme clusters.

Also worth knowing: `sys.stdout.encoding` is usually `utf-8` on Linux and macOS, but on Windows it follows the system code page (which may be `cp936` for a Chinese locale). Once the terminal and the producer disagree about the encoding, `你好` turns into garbage — the classic `锟斤拷` family of bugs.

:::note
Since Python 3.7 you can set `PYTHONUTF8=1` to enable UTF-8 mode. Worth having on by default for cross-platform scripts.
:::

## 5. The terminal paints it

Bytes that reach the terminal still have a journey ahead:

1. Decode UTF-8 back into code points
2. Map code points to glyphs via the font's `cmap`
3. Layout: accumulate advances, decide glyph positions (CJK characters are usually full-width — twice as wide as Latin)
4. Rasterise to pixels and composite on the GPU

Fail at any step and you see boxes, question marks or shifted characters instead of "hello, world". Most so-called terminal garbling happens at step 1; the rest is a missing glyph at step 2.

## 6. The other road: hello world in a browser

Printing a few characters on a web page takes a completely different route. Open any page of this site and roughly this happens:

```http
GET /posts/hello-world/ HTTP/1.1
Host: xiqian-blog.xiqian-blog.workers.dev
Accept: text/html
```

From pressing Enter to seeing text, the browser does at least this much:

1. Resolve the domain (zero cost if cached)
2. TCP handshake, TLS 1.3 negotiation (1-RTT, or 0-RTT on resumption)
3. Send the HTTP request, receive a stream of HTML bytes
4. The HTML parser parses incrementally, requesting `<link>` and `<script>` resources as it finds them
5. Build the DOM and CSSOM, then the render tree
6. Layout: compute the position and size of every box
7. Paint and composite to pixels

This site is statically built with Astro: `pnpm build` pre-renders every post to HTML, and Cloudflare Workers serves the output straight from edge nodes. After step 3 there is no database query and no server-side rendering — just a file read.

## 7. Two roads, one shared fact

Side by side:

| Stage | Terminal | Browser |
| --- | --- | --- |
| Compile | Source → bytecode | Source → HTML (at build time) |
| Execute | Interpreter runs instructions | DOM/CSSOM construction and layout |
| Transport | `write(1, ...)` syscall | HTTP response body |
| Decode | Terminal decodes UTF-8 | HTML parser decodes per `<meta charset>` |
| Present | Font rasterisation | Paint and composite |

The differences are many, but there is one shared fact: **characters exist as bytes at every station of the pipeline and are only turned back into glyphs at the very end.** Once you internalise that, mojibake stops being mysterious — it is an engineering problem you can locate, and it always comes down to an encoder and a decoder disagreeing about the contract.

---

Between `print("hello, world")` and those characters on screen sit a compiler, a virtual machine, a kernel, an encoding table and a font. The reason this line is a ritual is probably that it is the shortest path you can take through an entire machine by hand.

Next time you write `Hello, World`, try one more `dis.dis` — the machine underneath will tell you what it did.
