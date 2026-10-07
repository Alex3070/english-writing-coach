# 英语写作批改老师

一个本地运行的网页工具，专为**练习英语写作的中文母语者**设计。

你写下两样东西：

1. **你写的英文**
2. **用中文说明你本来想表达的意思**

然后工具会调用大模型（DeepSeek）以「英语老师」的身份批改你的英文：找出语法、用词、搭配、语气问题，逐条用中文讲清原因和规则，最后给出修改后全文、母语者版本、评分和该记住的知识点。

---

## 为什么要有「中文意图」这一栏

普通语法检查工具只能判断句子本身对不对，没法判断**你有没有说到位**。

比如你写 `I will come back again next week`，语法没错；但你想说的是「回那家咖啡馆」，而 `come` 表示朝说话人所在位置移动——用 `come` 其实是错的。只有知道你真正想说什么，老师才能发现这类问题。

所以这个工具的批改结果里，第一张卡片永远是「意思有没有说到位」：老师会复述他理解的意思，并指出你的英文实际传达出的意思和你的本意差在哪里。

---

## 快速开始

需要 **Node.js 20.11 或更高版本**（用到了 `import.meta.dirname` 和全局 `fetch`）。

### Windows 一键启动

双击项目里的 **`start.bat`** 就行。它会自动启动服务并在 2 秒后打开浏览器。

如果服务已经在运行，它不会再启一个，而是直接把页面打开（避免出现 `EADDRINUSE` 报错后窗口一闪而过）。窗口里的 `Ctrl + C` 可以停止服务。

### 命令行启动

```bash
cd newproject_1
npm start
```

然后打开终端里提示的地址：**http://127.0.0.1:6801**

不需要 `npm install`——整个项目零依赖，只用 Node 内置模块和浏览器原生 API。

### 配置 API Key

服务端按以下顺序查找 `DEEPSEEK_API_KEY`，第一个命中的生效：

1. 环境变量 `DEEPSEEK_API_KEY`
2. 项目根目录的 `.env` 文件（推荐，见下）
3. 本机 DSH 已有的凭证文件 `~/.dsh/.credentials.yaml`

在项目根目录新建 `.env`：

```
DEEPSEEK_API_KEY=sk-你的密钥
```

密钥只保存在你自己电脑上，请求由本机服务发往 DeepSeek 接口，不经过任何第三方。页面右上角会显示 Key 是否就绪。

### 可选的环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `6801` | 服务端口 |
| `DEEPSEEK_MODEL` | `deepseek-flash` | 默认模型，页面上也能切换 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 接口地址（OpenAI 兼容格式） |

> Windows 会保留一些动态端口段，默认端口 6801 已避开。如果提示端口被占用或 `EACCES`，用 `PORT=8080 npm start` 换个端口即可。查看被保留的端口段：`netsh interface ipv4 show excludedportrange protocol=tcp`。

---

## 怎么用

1. 左边输入框粘贴你写的英文。
2. 右边输入框用中文写清你本来想表达的意思（写得越具体越好：时间、对象、语气都写上）。
3. 按需调整选项：
   - **批改严格程度**：宽松（只挑影响理解的错）/ 标准 / 严格（按母语者标准抠细节）
   - **写作场景**：日常、学术、商务、考试作文、英文邮件——老师会按对应文体的标准点评
   - **重点关注**：勾选时态、冠词、介词等，老师会重点覆盖这些方面
   - **附带母语者润色版**：关掉可以只看纠错，不看改写
4. 点「开始批改」或按 `Ctrl + Enter`。

批改结果是**流式逐条出现**的，不用等全部结束：老师先告诉你「意思有没有说到位」，然后一条条列出问题，再给修改后的全文、母语者版本、评分和学习要点。

结果出来之后可以：

- **追问**：在底部问「为什么这里要用过去时？」「再给我三个例句」，老师会结合你这篇作文回答。
- **导出批改报告（Markdown）**：存成笔记，方便复习。
- **历史记录**：每次批改自动存在浏览器本地（最多 20 条），点一下就能回看，数据不会上传。

---

## 批改结果包含什么

| 区块 | 内容 |
| --- | --- |
| 意思有没有说到位 | 老师理解的本意、你的英文实际传达的意思、两者的差距 |
| 问题清单 | 每条含：类别（时态/冠词/介词/搭配/中式英语…）、严重程度、原文片段、修改后片段、中文原因讲解、正确例句 |
| 修改后的英文 | 只改错、保留你的原意的完整版本，改动片段用绿底标出，可展开对照原文 |
| 母语者会这样写 | 按母语者习惯重写的版本，并说明差别在哪 |
| 用词升级 | 你用对了但不够地道的词，给出更自然的说法和使用场合 |
| 评分 | 综合分 + 语法/用词/地道度/意思传达分项 + CEFR 水平估计 + 总评 |
| 今天记住这几点 | 2–4 条针对这篇作文的知识点讲解 |

---

## 项目结构

```
newproject_1/
├── start.bat               # Windows 双击启动（启动服务 + 打开浏览器）
├── server.mjs              # HTTP 服务：静态资源 + 批改/追问接口
├── src/
│   ├── config.mjs          # 端口、模型、API Key 解析
│   ├── llm.mjs             # DeepSeek 流式客户端（零依赖）
│   └── prompts.mjs         # 批改提示词与 JSONL 输出协议
├── public/
│   ├── index.html          # 界面结构
│   ├── styles.css          # 样式
│   ├── article-render.mjs  # 纯逻辑：在改写后的英文里定位改动片段（有单元测试）
│   └── app.js              # 流式渲染、追问、历史、导出
├── scripts/
│   ├── render-test.mjs     # 渲染逻辑单元测试（毫秒级，不需要浏览器）
│   ├── show-prompt.mjs     # 打印实际发送给模型的提示词（调提示词时用）
│   ├── probe.mjs           # 检查模型是否严格遵守输出协议
│   ├── smoke.mjs           # 接口冒烟测试（真实调用模型）
│   └── ui-check.mjs        # 无头浏览器端到端检查 + 截图
└── package.json
```

想看模型到底收到了什么提示词：

```bash
node scripts/show-prompt.mjs                  # 批改提示词
node scripts/show-prompt.mjs --mode all       # 批改 + 补全 + 追问
node scripts/show-prompt.mjs --strictness strict --register academic
node scripts/show-prompt.mjs --out prompt-preview   # 同时写文件
```

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 可用模型、Key 状态 |
| POST | `/api/review` | 批改，`{english, chinese, options, model}`，返回 NDJSON 流 |
| POST | `/api/ask` | 追问，`{english, chinese, review, question, history, model}`，返回 NDJSON 流 |

### 流式协议

模型被要求**一行输出一个 JSON 对象**（JSONL），服务端解析后逐行转发给浏览器：

```json
{"kind":"card","card":{"type":"intent","understood":"…","match":"partial","gap":"…"}}
{"kind":"card","card":{"type":"issue","id":1,"category":"时态",…}}
{"kind":"card","card":{"type":"corrected","text":"…","summary":"…"}}
{"kind":"card","card":{"type":"score","overall":70,…}}
{"kind":"done","cards":18,"elapsedMs":13933}
```

卡片类型顺序固定为 `intent → issue* → corrected → native → upgrade* → score → takeaway* → done`，前端收到一张就渲染一张，所以第一张卡片通常在 6–7 秒内就出现了，而不是等整个批改结束。

这种设计还有个好处：单行 JSON 解析失败时可以单独跳过并提示，不会因为一处格式问题让整次批改作废。

---

## 开发与自检

```bash
npm start                  # 启动服务
npm test                   # 渲染逻辑单元测试（毫秒级，不需要浏览器和网络）
npm run probe              # 验证模型是否严格遵守 JSONL 协议（会打印每行解析结果与耗时）
node scripts/smoke.mjs     # 接口冒烟测试：静态页、参数校验、真实批改、追问
node scripts/ui-check.mjs  # 无头 Chrome 打开页面 → 填表 → 点批改 → 检查渲染 → 截图
```

`ui-check.mjs` 需要本机装有 Chrome 或 Edge，截图会保存到 `ui-shots/`。它会断言**页面上渲染出来的英文和模型返回的文本逐字一致**，并用「我学习英文有一段时间了」这个短句做回归场景。

> 注意：如果浏览器运行在受限沙箱里（无法创建命名管道），Chrome 会以 `mojo platform_channel: Access is denied` 失败，这时需要在正常权限下运行该脚本。

### 关于「修改后的英文」是怎么渲染的

这里踩过一个坑，值得记一笔：最初用**词级 diff** 去猜原句和改写句的对齐，好标出改动位置。但两者语序差别大时，diff 会把 `a`、`time` 这类词配到错误位置，于是渲染出读不通的句子——比如把 `I have a far time to learn English` 和改写句交错成了 `I have abeen farlearning timeEnglish tofor learna Englishlong time.`。

现在改成**用问题卡里模型给出的 `quote → fix` 对应关系来定位改动片段**：这是模型自己认定的准确对应，不需要猜。渲染出来的文字永远和模型返回的文本逐字一致，只是给改动片段套一层高亮；片段太长（超过 8 个词）、和原句相同、或定位不到时就不标。这套逻辑在 `public/article-render.mjs` 里，由 `npm test` 覆盖。

---

## 常见问题

**批改时报「模型这次没有按格式返回批改内容」**
重试一次即可；如果反复出现，把右上角模型切到 `DeepSeek-V4-Pro`。`npm run probe` 可以确认是接口问题还是偶发问题。

**第一次出结果要等 7 秒左右**
模型在输出批改内容前会先做一轮推理，这段时间页面顶部会显示「老师正在思考…」。想更快可以选 `deepseek-flash`；`deepseek-v4-pro` 更细致但更慢。

**一次能批改多长的作文？**
单次上限 20000 字符。长文建议分段批改，批改质量也更好。

**支持别的模型吗？**
任何 OpenAI 兼容的 `/chat/completions` 接口都可以：把 `DEEPSEEK_BASE_URL` 指向你的服务，并在 `src/config.mjs` 的 `AVAILABLE_MODELS` 里改模型清单。
