---
title: 你好，世界：一行代码从源码到屏幕
published: 2026-10-18
updated: 2026-10-20
description: 把 print("你好，世界") 拆开：CPython 怎么把它编译成字节码、字节码怎么走到 write(1)、15 个字节怎么变成 UTF-8、终端怎么把它们画成字，以及浏览器里的 hello world 又走了哪条路。
image: ''
tags: [Python, 计算机原理, 前端]
category: 技术
draft: false
---

`print("你好，世界")` 是绝大多数人写下的第一行代码。它短到不需要解释，却也长到足够穿过一整台计算机：编译器、虚拟机、C 运行时、系统调用、编码表、字体、光栅化。

这篇文章就沿着这一行代码往下挖，看它到底经过了哪些站。

## 一、源码不是程序

我们写下的只是一段文本。Python 解释器拿到它之后，第一件事是搞清楚这段文本的结构：

1. 词法分析：把字符流切成 token（`NAME print`、`OP (`、`STRING "你好，世界"`）
2. 语法分析：按语法规则把 token 组装成 AST
3. 编译：把 AST 转成字节码
4. 虚拟机：逐条执行字节码

前两步在 CPython 里由 PEG 解析器完成，第三、四步是两条完全不同的路径——字节码是「指令」，虚拟机是「CPU」。

顺手看一眼 AST，Python 自带 `ast` 模块：

```python
import ast
print(ast.dump(ast.parse('print("你好，世界")'), indent=2))
```

```text
Module(
  body=[
    Expr(
      value=Call(
        func=Name(id='print', ctx=Load()),
        args=[Constant(value='你好，世界')],
        keywords=[]))],
  type_ignores=[])
```

树形结构很清楚：一个表达式语句，里面是一次函数调用，唯一的实参是一个字符串常量。

## 二、编译成字节码

真正被执行的不是 AST，而是从 AST 生成的字节码。`compile()` 加 `dis` 就能看到：

```python
import dis

code = compile('print("你好，世界")', "<string>", "exec")
dis.dis(code)
```

Python 3.13 的输出：

```text
  0           RESUME                   0

  1           LOAD_NAME                0 (print)
              PUSH_NULL
              LOAD_CONST               0 ('你好，世界')
              CALL                     1
              POP_TOP
              RETURN_CONST             1 (None)
```

几件事值得注意：

- `LOAD_CONST` 说明字符串在编译期就被放进了常量池（`code.co_consts == ('你好，世界', None)`），运行时不需要重新构造
- `LOAD_NAME` 而不是 `LOAD_GLOBAL`，因为这段代码在模块顶层，名字查找要从局部命名空间开始
- `PUSH_NULL` 是 3.11 引入的调用约定细节：它把一个 NULL 压栈，用来标记「这次调用不是方法调用」，从而省掉一次运行时的类型判断
- `RETURN_CONST` 是 3.12 新增的零开销返回，直接返回常量，而不是先压栈再 `RETURN_VALUE`

这些指令没有一条和「中文」有关。字符串在字节码里就是一个对象引用，编码问题被推迟到了它真正要离开进程的那一刻。

## 三、从 CALL 到 write(1)

`CALL 1` 最终落到 C 函数 `builtin_print`，逻辑可以简化成：

```c
for (each arg) {
    PyFile_WriteObject(arg, sys.stdout, Py_PRINT_RAW);
}
PyFile_WriteString("\n", sys.stdout);
if (flush) PyFile_Flush(sys.stdout);
```

也就是说，`print` 并不直接写屏幕，它只是往 `sys.stdout` 这个文件对象里写。`sys.stdout` 是三层结构：

```text
TextIOWrapper  →  str / bytes 转换，处理编码和换行
BufferedWriter →  攒够一批再交给内核
FileIO         →  真正的 write(2) 系统调用
```

最底下那层才是 `write(1, buf, n)`——把一段字节塞给内核，1 是标准输出的文件描述符。到这一步，进程就不再关心「字」了，它只关心字节。

### 缓冲策略决定了你看到什么

`BufferedWriter` 的行为取决于它连在哪里：

| 输出目标 | 缓冲方式 | 后果 |
| --- | --- | --- |
| 终端（tty） | 行缓冲 | 遇到换行就刷新，符合直觉 |
| 管道 / 文件 | 块缓冲（通常 8 KiB） | 没攒满就不写，看起来像「卡住」 |
| `python -u` 或 `PYTHONUNBUFFERED=1` | 不缓冲 | 每次写都直达内核，慢但即时 |

所以下面两行命令的行为是不一样的：

```bash
python -c 'print("你好，世界")' | cat          # 块缓冲，进程退出时才 flush
python -u -c 'print("你好，世界")' | cat       # 无缓冲，立刻可读
```

写日志的服务被 `kill -9` 打死时丢掉最后几行，根因就在这里：数据还躺在用户态缓冲区，没来得及进内核。`print(..., flush=True)` 是更精确的解法。

:::tip
想看这行代码真正发出的系统调用，Linux 上用 `strace -e write python3 -c 'print("你好，世界")'`，macOS 上用 `dtruss`。你会看到字节数正好是 16：15 个 UTF-8 字节加上换行。
:::

## 四、15 个字节的来历

`"你好，世界"` 一共 5 个字符：

```python
s = "你好，世界"
print(len(s))                  # 5  —— Unicode 码位数量
print(len(s.encode("utf-8")))   # 15 —— 字节数量
print([hex(ord(c)) for c in s])
```

```text
['0x4f60', '0x597d', '0xff0c', '0x4e16', '0x754c']
```

按 UTF-8 的三字节模板 `1110xxxx 10xxxxxx 10xxxxxx` 摊开：

| 字符 | 码位 | UTF-8 字节 |
| --- | --- | --- |
| 你 | U+4F60 | `E4 BD A0` |
| 好 | U+597D | `E5 A5 BD` |
| ， | U+FF0C | `EF BC 8C` |
| 世 | U+4E16 | `E4 B8 96` |
| 界 | U+754C | `E7 95 8C` |

5 个字符 → 15 个字节，膨胀 3 倍。这就是为什么中文文本的「字数」和「体积」永远对不上，也是为什么按字节截断字符串会把一个字劈成两半——`E4 BD` 后面缺了 `A0`，剩下的就是乱码。要安全截断，得按码位或字素簇来切。

顺带一提：Linux / macOS 上 `sys.stdout.encoding` 通常是 `utf-8`，Windows 上则跟随系统代码页（中文环境可能是 `cp936`）。一旦终端和输出端的编码约定不一致，`你好` 就会变成 `浣犲ソ` 这类「锟斤拷」家族的产物。

:::note
Python 3.7 起可以用 `PYTHONUTF8=1` 打开 UTF-8 模式，跨平台脚本建议常开。
:::

## 五、终端把它画成字

字节到达终端后，还要走一段路：

1. 终端按 UTF-8 解码，把字节还原成码位
2. 用字体做字符映射（cmap），找到每个码位对应的字形
3. 排版引擎累加字宽、决定字形位置（中文字符通常是全角，宽度是西文的两倍）
4. 光栅化成像素，交给 GPU 合成

任何一步失败，你看到的都不是「你好，世界」，而是方块、问号或者错位的字符。所谓「终端乱码」，绝大多数出在第 1 步，剩下的出在第 2 步缺字体。

## 六、换条路：浏览器里的 hello world

同样是打印几个字，网页走的是另一条完全不同的链路。打开本站任意页面，背后大致是这样：

```http
GET /posts/hello-world/ HTTP/1.1
Host: xiqian-blog.xiqian-blog.workers.dev
Accept: text/html
```

从敲下回车到看见文字，浏览器至少做了这些事：

1. DNS 解析域名（命中缓存的话这一步耗时为零）
2. TCP 握手，TLS 1.3 协商（1-RTT，或 0-RTT 恢复）
3. 发出 HTTP 请求，收到 HTML 字节流
4. HTML 解析器边下边解析，遇到 `<link>` 和 `<script>` 再去请求资源
5. 构建 DOM 树和 CSSOM，合成渲染树
6. 布局（layout）算出每个盒子的位置和尺寸
7. 绘制（paint）与合成（composite），像素上屏

本站是用 Astro 静态构建的：`pnpm build` 把每篇文章预渲染成 HTML，产物交给 Cloudflare Workers 的静态资源层，全球边缘节点直接返回。所以第 3 步之后没有数据库查询、也没有服务端渲染，只有一次文件读取。

## 七、两条链路，一个共同点

把两条路径并排看：

| 阶段 | 终端 | 浏览器 |
| --- | --- | --- |
| 编译 | 源码 → 字节码 | 源码 → HTML（构建期完成） |
| 执行 | 虚拟机逐条执行指令 | DOM/CSSOM 构建与布局 |
| 传输 | `write(1, ...)` 系统调用 | HTTP 响应体字节流 |
| 解码 | 终端按 UTF-8 解码 | HTML 解析器按 `<meta charset>` 解码 |
| 呈现 | 字体光栅化上屏 | 绘制与合成上屏 |

不同点很多，共同点只有一个：**中文字符在整条链路上都以字节形式存在，只有在最末端才被还原成「字」**。理解了这一点，「乱码」就不再是玄学，而是一个可以被定位的工程问题——它一定出在某一次编码与解码的约定不一致上。

---

从 `print("你好，世界")` 到屏幕上那五个字，中间隔着编译器、虚拟机、内核、编码表和字体。这一行代码之所以被当作仪式，大概是因为它是你能亲手触碰整台机器的最短路径。

下次写 `Hello, World` 的时候，不妨多按一次 `dis.dis`——底下那台机器会告诉你它做了什么。
