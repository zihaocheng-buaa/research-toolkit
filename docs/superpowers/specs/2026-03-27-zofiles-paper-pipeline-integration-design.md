# ZoFiles × Paper Pipeline Service 集成设计

> 生成时间：2026-03-27
> 状态：待实现

---

## 背景

ZoFiles 是一个 Zotero 插件，将文献库导出为 AI 友好的文件夹结构。当前它通过
`MarkdownProvider` 调用第三方 `arxiv2md.org` 生成 `paper.md`，但无法提取 arXiv
论文的 LaTeX 源码，也无法对非 arXiv 论文做高质量的 PDF 转换（含公式识别）。

本设计目标：**让 ZoFiles 在导出时自动调用本地 Paper Pipeline Service，完成所有
源文件准备工作，使 Claude 后续可以直接调用 read-paper skill 进行深度分析，无需
手动准备文件。**

---

## 目标

- arXiv 论文：自动提取 LaTeX 源码，保存为 `paper.latex`
- 非 arXiv 论文：自动将 PDF 转换为高质量 Markdown（含公式识别），保存为 `paper.md`
- 服务不可用时：显示 Zotero 警告通知，不阻塞其他文件的导出
- 服务地址：在偏好设置中可配置，默认 `http://localhost:7070`

---

## 不在范围内

- ZoFiles 不调用 Claude API，不生成 `ai-review.md`
- `ai-review.md` 仍由用户手动触发 Claude 的 read-paper skill 生成
- 不修改现有 provider（arxivid, pdf, bibtex, notes, kimi）

---

## 架构变更

### 文件变更

```
src/modules/content-providers/
├── markdown-provider.ts     ← 删除（替换为以下两个）
├── latex-provider.ts        ← 新增
└── pipeline-pdf-provider.ts ← 新增

src/modules/preferences.ts   ← 修改：新增 pipelineServiceUrl 配置
addon/preferences/           ← 修改：新增 UI 输入框和测试连接按钮
src/modules/content-providers/registry.ts ← 修改：注册新 provider
```

### Provider 执行顺序（修改后）

| 顺序 | Provider | 输出文件 | 速度 |
|------|----------|----------|------|
| 1 | ArxivIdProvider | `arxiv.id` | 即时 |
| 2 | PdfProvider | `paper.pdf` | 快 |
| 3 | BibtexProvider | `paper.bib` | 缓存网络 |
| 4 | NotesProvider | `notes/*.md` | 中等 |
| 5 | KimiProvider | `kimi.md` | 缓存网络 |
| 6 | **LatexProvider** | `paper.latex` | 快（同步） |
| 7 | **PipelinePdfProvider** | `paper.md` | 慢（异步后台） |

---

## `LatexProvider` 详细设计

**文件**：`src/modules/content-providers/latex-provider.ts`

**触发条件**：`ctx.arxivId` 非空（arXiv 论文）

**流程**：

```
export(ctx):
  1. 若 paper.latex 已存在 → 返回 { success: true, files: [] }（缓存命中）
  2. GET {serviceUrl}/health
     → 失败或 mineru != 'available'：
       显示 Zotero 警告："Paper Pipeline Service 不可用，请启动服务"
       返回 { success: false }
  3. POST {serviceUrl}/arxiv-to-latex
     body: { arxiv_id: ctx.arxivId }
  4. 写入 paper.latex（latex_content 字段）
  5. 返回 { success: true, files: ['paper.latex'] }
```

**接口调用**：

```typescript
// POST /arxiv-to-latex
// Request:  { arxiv_id: string }
// Response: { success: boolean, latex_content: string, bib_content?: string }
```

**prefKey**：`extensions.zofiles.providers.latex`（默认启用）

---

## `PipelinePdfProvider` 详细设计

**文件**：`src/modules/content-providers/pipeline-pdf-provider.ts`

**触发条件**：`ctx.arxivId` 为空（非 arXiv 论文）

**流程**：

```
export(ctx):
  1. 若 paper.md 已存在 → 返回 { success: true, files: [] }（缓存命中）
  2. 获取论文 PDF 路径（ctx.item 的第一个 PDF 附件）
     → 无 PDF：返回 { success: false, error: 'No PDF found' }
  3. GET {serviceUrl}/health
     → 失败：显示 Zotero 警告，返回 { success: false }
  4. POST {serviceUrl}/convert-pdf
     body: { pdf_path: string }
     → 获得 task_id
  5. 立即返回 { success: true, files: [] }（不等待转换完成）
  6. 后台启动轮询（setInterval，每 15 秒）：
     GET {serviceUrl}/convert-pdf/{task_id}
     → status == 'done'：写入 paper.md，清除定时器，显示 Zotero 通知"paper.md 已生成"
     → status == 'failed'：清除定时器，显示 Zotero 通知"PDF 转换失败"
     → 超时（20 分钟）：清除定时器，显示 Zotero 通知"PDF 转换超时"
```

**接口调用**：

```typescript
// POST /convert-pdf
// Request:  { pdf_path: string }
// Response: { success: boolean, task_id: string, status: string }

// GET /convert-pdf/{task_id}
// Response: { success: boolean, status: 'processing'|'done'|'failed', markdown?: string }
```

**prefKey**：`extensions.zofiles.providers.pipelinePdf`（默认启用）

---

## 偏好设置变更

### 新增配置项

**prefKey**：`extensions.zofiles.pipelineServiceUrl`
**默认值**：`http://localhost:7070`
**类型**：string

### UI 变更（偏好设置页面）

在现有 content providers 区块下方新增：

```
─────────────────────────────────────────
Paper Pipeline Service
服务地址: [____http://localhost:7070____]
          [测试连接]  ← 点击后显示：✅ 服务正常 / ❌ 服务不可用
─────────────────────────────────────────
```

### 获取服务地址

两个新 provider 均通过以下方式获取服务地址：

```typescript
const serviceUrl = Zotero.Prefs.get(
  'extensions.zofiles.pipelineServiceUrl',
  'http://localhost:7070'
) as string;
```

---

## 警告通知设计

服务不可用时，使用 Zotero 的通知系统（与现有 KimiProvider 保持一致）：

```typescript
// 服务不可用警告
Zotero.alert(
  null,
  'ZoFiles - Paper Pipeline Service 不可用',
  `无法连接到 Paper Pipeline Service (${serviceUrl})。\n\n` +
  `请启动服务：\n` +
  `cd ~/Documents/research-toolkit/paper_pipeline\n` +
  `python service.py`
);
```

**频率控制**：同一导出批次中，同一错误只弹一次（避免批量导出时重复弹窗）。

---

## 完整导出后的文件夹结构

```
{arxivId} - {title}/
├── paper.pdf        ← PdfProvider
├── paper.bib        ← BibtexProvider
├── arxiv.id         ← ArxivIdProvider
├── kimi.md          ← KimiProvider
├── paper.latex      ← LatexProvider（arXiv 论文）
│   或
├── paper.md         ← PipelinePdfProvider（非 arXiv 论文，异步生成）
└── notes/
    └── *.md         ← NotesProvider
```

---

## 与 read-paper skill 的关系

ZoFiles 完成导出后，文件夹已包含 `paper.latex` 或 `paper.md`。
用户可随时对 Claude 说：

```
请阅读这篇论文：~/Papers/2404.12345 - Some Title/
```

Claude 调用 `read-paper` skill，读取已准备好的文件，生成 `notes/ai-review.md`。
**全程无需用户手动准备任何文件。**

---

## 实现步骤

1. Clone ZoFiles 仓库到本地
2. 删除 `src/modules/content-providers/markdown-provider.ts`
3. 新增 `src/modules/content-providers/latex-provider.ts`
4. 新增 `src/modules/content-providers/pipeline-pdf-provider.ts`
5. 修改 `src/modules/content-providers/registry.ts`：注销 MarkdownProvider，注册两个新 provider
6. 修改 `src/modules/preferences.ts`：新增 `pipelineServiceUrl` 配置项
7. 修改偏好设置 UI：新增服务地址输入框和测试连接按钮
8. 构建并在 Zotero 中测试

---

*本文档由 Claude Sonnet 4.6 生成，基于 ZoFiles 源码分析和用户需求。*
