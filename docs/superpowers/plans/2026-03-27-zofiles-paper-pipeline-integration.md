# ZoFiles × Paper Pipeline Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ZoFiles' `MarkdownProvider` (arxiv2md.org) with two new providers that call a local Paper Pipeline Service — `LatexProvider` for arXiv papers (produces `paper.latex`) and `PipelinePdfProvider` for non-arXiv papers (produces `paper.md` asynchronously).

**Architecture:** Two new content providers follow the existing `BaseProvider` pattern. `LatexProvider` calls `/arxiv-to-latex` synchronously; `PipelinePdfProvider` calls `/convert-pdf` and polls in the background via `setInterval`. A shared `checkServiceHealth()` helper avoids duplicated fetch logic. Service URL is stored in a new preference key `pipelineServiceUrl`.

**Tech Stack:** TypeScript, Zotero plugin API (`IOUtils`, `Zotero.Prefs`, `Zotero.setTimeout`), XUL/XHTML for preferences UI, existing `BaseProvider` / `ExportContext` / `ProviderResult` interfaces.

---

## File Map

| Action | File |
|--------|------|
| Delete | `src/modules/content-providers/markdown-provider.ts` |
| Create | `src/modules/content-providers/latex-provider.ts` |
| Create | `src/modules/content-providers/pipeline-pdf-provider.ts` |
| Modify | `src/modules/content-providers/registry.ts` |
| Modify | `addon/prefs.js` |
| Modify | `src/modules/preferences.ts` |
| Modify | `addon/content/preferences.xhtml` |
| Modify | `addon/locale/en-US/preferences.ftl` (add new strings) |

---

## Task 1: Clone ZoFiles and set up dev environment

**Files:**
- Working directory: `~/Documents/ZoFiles/`

- [ ] **Step 1: Clone the repository**

```bash
cd ~/Documents
git clone https://github.com/X1AOX1A/ZoFiles.git
cd ZoFiles
```

- [ ] **Step 2: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Verify build works**

```bash
npm run build
```

Expected: `builds/` directory created with `.xpi` file. No TypeScript errors.

- [ ] **Step 4: Commit baseline**

```bash
git checkout -b feature/paper-pipeline-integration
git commit --allow-empty -m "chore: start paper-pipeline-integration branch"
```

---

## Task 2: Delete `markdown-provider.ts` and remove from registry

**Files:**
- Delete: `src/modules/content-providers/markdown-provider.ts`
- Modify: `src/modules/content-providers/registry.ts`

- [ ] **Step 1: Delete the file**

```bash
rm src/modules/content-providers/markdown-provider.ts
```

- [ ] **Step 2: Update `registry.ts`**

Replace the entire file content with:

```typescript
import { ContentProvider } from "./provider";
import { ArxivIdProvider } from "./arxivid-provider";
import { PdfProvider } from "./pdf-provider";
import { BibtexProvider } from "./bibtex-provider";
import { NotesProvider } from "./notes-provider";
import { KimiProvider } from "./kimi-provider";
import { LatexProvider } from "./latex-provider";
import { PipelinePdfProvider } from "./pipeline-pdf-provider";

/**
 * All registered content providers in execution order.
 *
 * Ordered from fastest/local-only to slowest/network-dependent:
 *   1. ArxivId        — instant file write
 *   2. PDF            — local copy/symlink
 *   3. BibTeX         — small network fetch (cached)
 *   4. Notes          — local Zotero data
 *   5. Kimi           — network fetch (cached)
 *   6. Latex          — Paper Pipeline Service, sync (arXiv only)
 *   7. PipelinePdf    — Paper Pipeline Service, async background (non-arXiv)
 */
const allProviders: ContentProvider[] = [
  new ArxivIdProvider(),
  new PdfProvider(),
  new BibtexProvider(),
  new NotesProvider(),
  new KimiProvider(),
  new LatexProvider(),
  new PipelinePdfProvider(),
];

/**
 * Map of provider ID → provider instance for O(1) direct lookup.
 */
const providerMap = new Map<string, ContentProvider>(
  allProviders.map((p) => [p.id, p]),
);

/**
 * Get all providers that are currently enabled via user preferences.
 * Returns them in execution order.
 */
export function getEnabledProviders(): ContentProvider[] {
  return allProviders.filter((p) => p.isEnabled());
}

/**
 * Get all registered providers regardless of enabled state.
 * Returns them in execution order.
 */
export function getAllProviders(): ContentProvider[] {
  return [...allProviders];
}

/**
 * Get a specific provider by its ID.
 * Returns undefined if no provider with that ID exists.
 */
export function getProvider(id: string): ContentProvider | undefined {
  return providerMap.get(id);
}
```

- [ ] **Step 3: Verify TypeScript compiles (errors expected — new files not yet created)**

```bash
npm run build 2>&1 | head -20
```

Expected: Errors about `LatexProvider` and `PipelinePdfProvider` not found. That's correct — we'll create them next.

- [ ] **Step 4: Commit**

```bash
git add src/modules/content-providers/registry.ts
git rm src/modules/content-providers/markdown-provider.ts
git commit -m "refactor: remove MarkdownProvider, register LatexProvider and PipelinePdfProvider"
```

---

## Task 3: Create `latex-provider.ts`

**Files:**
- Create: `src/modules/content-providers/latex-provider.ts`

- [ ] **Step 1: Create the file**

```typescript
// src/modules/content-providers/latex-provider.ts
import { BaseProvider, ExportContext, ProviderResult } from "./provider";
import { joinPath } from "../utils";
import { getPref } from "../../utils/prefs";

/**
 * One-time alert tracker: avoid spamming the user when batch-exporting
 * many papers and the service is down.
 */
let serviceAlertShownThisSession = false;

/**
 * Check Paper Pipeline Service health.
 * Returns true if service is reachable and MinerU is available.
 */
async function checkServiceHealth(serviceUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${serviceUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.services?.mineru === "available";
  } catch {
    return false;
  }
}

/**
 * Show a one-per-session alert when the Paper Pipeline Service is unreachable.
 */
function alertServiceUnavailable(serviceUrl: string): void {
  if (serviceAlertShownThisSession) return;
  serviceAlertShownThisSession = true;
  Zotero.alert(
    null,
    "ZoFiles — Paper Pipeline Service 不可用",
    `无法连接到 Paper Pipeline Service (${serviceUrl})。\n\n` +
      `请启动服务：\n` +
      `cd ~/Documents/research-toolkit/paper_pipeline\n` +
      `python service.py`,
  );
}

/**
 * Fetches the LaTeX source of an arXiv paper via the local Paper Pipeline
 * Service and writes it as `paper.latex`.
 *
 * Only runs for arXiv papers (ctx.arxivId must be non-empty).
 * Results are cached since LaTeX source doesn't change.
 */
export class LatexProvider extends BaseProvider {
  readonly id = "latex";
  readonly displayName = "LaTeX Source";
  readonly prefKey = "exportLatex";

  async export(ctx: ExportContext): Promise<ProviderResult> {
    // Only handle arXiv papers
    if (!ctx.arxivId) {
      return { success: true, files: [] };
    }

    const targetPath = joinPath(ctx.paperDir, "paper.latex");

    try {
      // Cache check: if paper.latex already exists, skip
      const exists = await IOUtils.exists(targetPath);
      if (exists) {
        return { success: true, files: [targetPath] };
      }

      const serviceUrl = (getPref("pipelineServiceUrl" as any) as string) ||
        "http://localhost:7070";

      // Health check
      const healthy = await checkServiceHealth(serviceUrl);
      if (!healthy) {
        alertServiceUnavailable(serviceUrl);
        return {
          success: false,
          files: [],
          error: `Paper Pipeline Service not available at ${serviceUrl}`,
        };
      }

      // Fetch LaTeX source
      const response = await fetch(`${serviceUrl}/arxiv-to-latex`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ arxiv_id: ctx.arxivId }),
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        return {
          success: false,
          files: [],
          error: `arxiv-to-latex failed: HTTP ${response.status}`,
        };
      }

      const data = await response.json();

      if (!data.success || !data.latex_content) {
        return {
          success: false,
          files: [],
          error: data.error || "No latex_content in response",
        };
      }

      // Write paper.latex
      const content = new TextEncoder().encode(data.latex_content);
      await IOUtils.write(targetPath, content);

      return { success: true, files: [targetPath], linkBack: true };
    } catch (e: any) {
      return {
        success: false,
        files: [],
        error: `Failed to export LaTeX: ${e.message}`,
      };
    }
  }

  async cleanup(paperDir: string): Promise<void> {
    const filePath = joinPath(paperDir, "paper.latex");
    try {
      await IOUtils.remove(filePath, { ignoreAbsent: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles (one error remaining for PipelinePdfProvider)**

```bash
npm run build 2>&1 | grep -i error | head -10
```

Expected: Only errors about `PipelinePdfProvider` not found.

- [ ] **Step 3: Commit**

```bash
git add src/modules/content-providers/latex-provider.ts
git commit -m "feat: add LatexProvider — fetches arXiv LaTeX via Paper Pipeline Service"
```

---

## Task 4: Create `pipeline-pdf-provider.ts`

**Files:**
- Create: `src/modules/content-providers/pipeline-pdf-provider.ts`

- [ ] **Step 1: Create the file**

```typescript
// src/modules/content-providers/pipeline-pdf-provider.ts
import { BaseProvider, ExportContext, ProviderResult } from "./provider";
import { joinPath } from "../utils";
import { getPref } from "../../utils/prefs";

// Polling interval: 15 seconds
const POLL_INTERVAL_MS = 15_000;
// Timeout: 20 minutes
const POLL_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * One-time alert tracker to avoid spamming when batch-exporting.
 */
let serviceAlertShownThisSession = false;

/**
 * Check Paper Pipeline Service health.
 */
async function checkServiceHealth(serviceUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${serviceUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.services?.mineru === "available";
  } catch {
    return false;
  }
}

/**
 * Show a one-per-session alert when the service is unreachable.
 */
function alertServiceUnavailable(serviceUrl: string): void {
  if (serviceAlertShownThisSession) return;
  serviceAlertShownThisSession = true;
  Zotero.alert(
    null,
    "ZoFiles — Paper Pipeline Service 不可用",
    `无法连接到 Paper Pipeline Service (${serviceUrl})。\n\n` +
      `请启动服务：\n` +
      `cd ~/Documents/research-toolkit/paper_pipeline\n` +
      `python service.py`,
  );
}

/**
 * Converts a non-arXiv paper's PDF to Markdown via the local Paper Pipeline
 * Service and writes it as `paper.md`.
 *
 * Only runs for non-arXiv papers (ctx.arxivId must be empty).
 * Submits the conversion task and returns immediately; a background
 * setInterval polls for completion and writes the file when done.
 */
export class PipelinePdfProvider extends BaseProvider {
  readonly id = "pipelinePdf";
  readonly displayName = "PDF → Markdown (Pipeline)";
  readonly prefKey = "exportPipelinePdf";

  async export(ctx: ExportContext): Promise<ProviderResult> {
    // Only handle non-arXiv papers
    if (ctx.arxivId) {
      return { success: true, files: [] };
    }

    const targetPath = joinPath(ctx.paperDir, "paper.md");

    try {
      // Cache check: if paper.md already exists, skip
      const exists = await IOUtils.exists(targetPath);
      if (exists) {
        return { success: true, files: [targetPath] };
      }

      // Find the PDF attachment path
      const attachments = ctx.item.getAttachments();
      let pdfPath: string | null = null;
      for (const attachId of attachments) {
        const attachment = Zotero.Items.get(attachId);
        if (
          attachment &&
          attachment.isAttachment() &&
          attachment.attachmentContentType === "application/pdf"
        ) {
          pdfPath = await attachment.getFilePathAsync();
          if (pdfPath) break;
        }
      }

      if (!pdfPath) {
        return {
          success: false,
          files: [],
          error: "No PDF attachment found for this item",
        };
      }

      const serviceUrl = (getPref("pipelineServiceUrl" as any) as string) ||
        "http://localhost:7070";

      // Health check
      const healthy = await checkServiceHealth(serviceUrl);
      if (!healthy) {
        alertServiceUnavailable(serviceUrl);
        return {
          success: false,
          files: [],
          error: `Paper Pipeline Service not available at ${serviceUrl}`,
        };
      }

      // Submit conversion task
      const submitResponse = await fetch(`${serviceUrl}/convert-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdf_path: pdfPath }),
        signal: AbortSignal.timeout(30000),
      });

      if (!submitResponse.ok) {
        return {
          success: false,
          files: [],
          error: `convert-pdf submission failed: HTTP ${submitResponse.status}`,
        };
      }

      const submitData = await submitResponse.json();
      if (!submitData.success || !submitData.task_id) {
        return {
          success: false,
          files: [],
          error: submitData.error || "No task_id in response",
        };
      }

      const taskId = submitData.task_id;
      const startTime = Date.now();

      // Start background polling — return immediately
      const intervalId = Zotero.setInterval(async () => {
        // Timeout check
        if (Date.now() - startTime > POLL_TIMEOUT_MS) {
          Zotero.clearInterval(intervalId);
          new ztoolkit.ProgressWindow("ZoFiles")
            .createLine({
              text: `PDF 转换超时：${ctx.item.getField("title")}`,
              type: "fail",
            })
            .show()
            .startCloseTimer(5000);
          return;
        }

        try {
          const statusResponse = await fetch(
            `${serviceUrl}/convert-pdf/${taskId}`,
            { signal: AbortSignal.timeout(10000) },
          );
          if (!statusResponse.ok) return;

          const statusData = await statusResponse.json();
          const status = statusData.status;

          if (status === "done" && statusData.markdown) {
            Zotero.clearInterval(intervalId);
            // Write paper.md
            const content = new TextEncoder().encode(statusData.markdown);
            await IOUtils.write(targetPath, content);
            new ztoolkit.ProgressWindow("ZoFiles")
              .createLine({
                text: `paper.md 已生成：${ctx.item.getField("title")}`,
                type: "success",
              })
              .show()
              .startCloseTimer(5000);
          } else if (status === "failed") {
            Zotero.clearInterval(intervalId);
            new ztoolkit.ProgressWindow("ZoFiles")
              .createLine({
                text: `PDF 转换失败：${statusData.error || ctx.item.getField("title")}`,
                type: "fail",
              })
              .show()
              .startCloseTimer(5000);
          }
          // status === "processing": keep polling
        } catch {
          // Network hiccup — keep polling
        }
      }, POLL_INTERVAL_MS);

      // Return immediately — background polling handles the rest
      return { success: true, files: [] };
    } catch (e: any) {
      return {
        success: false,
        files: [],
        error: `Failed to submit PDF conversion: ${e.message}`,
      };
    }
  }

  async cleanup(paperDir: string): Promise<void> {
    const filePath = joinPath(paperDir, "paper.md");
    try {
      await IOUtils.remove(filePath, { ignoreAbsent: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

```bash
npm run build 2>&1 | grep -i error
```

Expected: No errors. Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/modules/content-providers/pipeline-pdf-provider.ts
git commit -m "feat: add PipelinePdfProvider — async PDF→Markdown via Paper Pipeline Service"
```

---

## Task 5: Add `pipelineServiceUrl` and new prefKeys to prefs system

**Files:**
- Modify: `addon/prefs.js`
- Modify: `typings/global.d.ts` (add new pref keys to `PluginPrefsMap`)

- [ ] **Step 1: Update `addon/prefs.js`**

Add three lines at the end of the file:

```javascript
pref("exportRoot", "");
pref("cachePath", "");
pref("paperFolderFormat", "{arxivId} - {title}");
pref("enabledCollections", "[]");
pref("exportPdf", true);
pref("exportMarkdown", true);
pref("exportKimi", true);
pref("exportBibtex", true);
pref("exportNotes", true);
pref("exportArxivId", true);
pref("pdfMode", "symlink");
pref("linkBackToZotero", false);
pref("autoSync", true);
pref("pipelineServiceUrl", "http://localhost:7070");
pref("exportLatex", true);
pref("exportPipelinePdf", true);
```

- [ ] **Step 2: Find and update `PluginPrefsMap` type definition**

```bash
grep -rn "PluginPrefsMap" typings/ src/
```

Open the file that defines `PluginPrefsMap` (likely `typings/global.d.ts` or similar). Add the three new keys:

```typescript
// Inside PluginPrefsMap interface, add:
pipelineServiceUrl: string;
exportLatex: boolean;
exportPipelinePdf: boolean;
```

- [ ] **Step 3: Verify build still passes**

```bash
npm run build 2>&1 | grep -i error
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add addon/prefs.js
git add typings/  # or wherever PluginPrefsMap lives
git commit -m "feat: add pipelineServiceUrl, exportLatex, exportPipelinePdf prefs"
```

---

## Task 6: Add Paper Pipeline Service section to preferences UI

**Files:**
- Modify: `src/modules/preferences.ts`
- Modify: `addon/content/preferences.xhtml`
- Modify: `addon/locale/en-US/preferences.ftl`

- [ ] **Step 1: Add UI section to `addon/content/preferences.xhtml`**

After the closing `</html:fieldset>` of Section 2 (Content Providers) and before Section 3 (PDF Mode), insert:

```xml
  <!-- ================================================================== -->
  <!-- Section 2b: Paper Pipeline Service                                 -->
  <!-- ================================================================== -->
  <html:fieldset style="margin-top: 12px">
    <html:legend data-l10n-id="pref-section-pipeline"></html:legend>

    <!-- Service URL -->
    <hbox align="center">
      <html:label
        for="zotero-prefpane-__addonRef__-pipeline-url"
        data-l10n-id="pref-pipeline-url"
        style="min-width: 120px"
      ></html:label>
      <html:input
        type="text"
        id="zotero-prefpane-__addonRef__-pipeline-url"
        style="flex: 1; margin: 0 8px"
        placeholder="http://localhost:7070"
      />
      <button
        id="zotero-prefpane-__addonRef__-pipeline-test"
        data-l10n-id="pref-pipeline-test"
      />
    </hbox>

    <!-- Test result label -->
    <hbox style="margin-top: 4px; padding-left: 128px">
      <html:span
        id="zotero-prefpane-__addonRef__-pipeline-status"
        style="font-size: 0.9em"
      ></html:span>
    </hbox>

    <!-- Provider toggles for new providers -->
    <vbox style="margin-top: 8px">
      <checkbox
        id="zotero-prefpane-__addonRef__-export-latex"
        data-l10n-id="pref-export-latex"
        preference="exportLatex"
      />
      <checkbox
        id="zotero-prefpane-__addonRef__-export-pipeline-pdf"
        data-l10n-id="pref-export-pipeline-pdf"
        preference="exportPipelinePdf"
      />
    </vbox>
  </html:fieldset>
```

- [ ] **Step 2: Add localization strings to `addon/locale/en-US/preferences.ftl`**

```bash
# Append to addon/locale/en-US/preferences.ftl
cat >> addon/locale/en-US/preferences.ftl << 'EOF'

pref-section-pipeline = Paper Pipeline Service
pref-pipeline-url = Service URL:
pref-pipeline-test = Test Connection
pref-export-latex = Export LaTeX source (arXiv papers)
pref-export-pipeline-pdf = Export PDF → Markdown (non-arXiv papers)
pref-pipeline-status-ok = ✅ Service available
pref-pipeline-status-fail = ❌ Service unavailable
EOF
```

- [ ] **Step 3: Add init and bind functions to `src/modules/preferences.ts`**

After the `initAdvancedSettings` function definition, add:

```typescript
// ---------------------------------------------------------------------------
// Paper Pipeline Service
// ---------------------------------------------------------------------------

/**
 * Initialize the Pipeline Service URL input from preferences.
 */
function initPipelineSettings(doc: Document): void {
  const urlInput = doc.getElementById(
    PREF_ID("pipeline-url"),
  ) as HTMLInputElement | null;
  if (urlInput) {
    urlInput.value =
      (getPref("pipelineServiceUrl" as any) as string) ||
      "http://localhost:7070";
  }

  // Initialize new provider toggle checkboxes
  const latexCheckbox = doc.getElementById(
    PREF_ID("export-latex"),
  ) as XUL.Checkbox | null;
  if (latexCheckbox) {
    latexCheckbox.checked = getPref("exportLatex" as any) as boolean;
  }

  const pipelinePdfCheckbox = doc.getElementById(
    PREF_ID("export-pipeline-pdf"),
  ) as XUL.Checkbox | null;
  if (pipelinePdfCheckbox) {
    pipelinePdfCheckbox.checked = getPref("exportPipelinePdf" as any) as boolean;
  }
}

/**
 * Bind events for Pipeline Service URL input and Test Connection button.
 */
function bindPipelineEvents(doc: Document): void {
  const urlInput = doc.getElementById(
    PREF_ID("pipeline-url"),
  ) as HTMLInputElement | null;
  const testBtn = doc.getElementById(PREF_ID("pipeline-test"));
  const statusSpan = doc.getElementById(
    PREF_ID("pipeline-status"),
  ) as HTMLElement | null;

  // Save URL on change
  if (urlInput) {
    urlInput.addEventListener("change", () => {
      setPref("pipelineServiceUrl" as any, urlInput.value.trim());
    });
    urlInput.addEventListener("blur", () => {
      setPref("pipelineServiceUrl" as any, urlInput.value.trim());
    });
  }

  // Test connection button
  if (testBtn && statusSpan) {
    testBtn.addEventListener("command", async () => {
      const url =
        urlInput?.value.trim() ||
        (getPref("pipelineServiceUrl" as any) as string) ||
        "http://localhost:7070";

      statusSpan.textContent = "Testing...";
      statusSpan.style.color = "";

      try {
        const response = await fetch(`${url}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          const data = await response.json();
          const mineruOk = data?.services?.mineru === "available";
          statusSpan.textContent = mineruOk
            ? getString("pref-pipeline-status-ok")
            : "⚠️ Service reachable but MinerU unavailable";
          statusSpan.style.color = mineruOk ? "#080" : "#c80";
        } else {
          statusSpan.textContent = getString("pref-pipeline-status-fail");
          statusSpan.style.color = "#c00";
        }
      } catch {
        statusSpan.textContent = getString("pref-pipeline-status-fail");
        statusSpan.style.color = "#c00";
      }
    });
  }

  // New provider toggle checkboxes
  const latexCheckbox = doc.getElementById(PREF_ID("export-latex"));
  if (latexCheckbox) {
    latexCheckbox.addEventListener("command", (e: Event) => {
      const target = e.target as XUL.Checkbox;
      setPref("exportLatex" as any, target.checked);
    });
  }

  const pipelinePdfCheckbox = doc.getElementById(
    PREF_ID("export-pipeline-pdf"),
  );
  if (pipelinePdfCheckbox) {
    pipelinePdfCheckbox.addEventListener("command", (e: Event) => {
      const target = e.target as XUL.Checkbox;
      setPref("exportPipelinePdf" as any, target.checked);
    });
  }
}
```

- [ ] **Step 4: Call the new functions from `registerPrefsScripts`**

In `registerPrefsScripts`, after `initAdvancedSettings(doc)`, add:

```typescript
  initPipelineSettings(doc);
```

After `bindAdvancedEvents(doc)`, add:

```typescript
  bindPipelineEvents(doc);
```

- [ ] **Step 5: Verify build passes**

```bash
npm run build 2>&1 | grep -i error
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add addon/prefs.js addon/content/preferences.xhtml \
        addon/locale/en-US/preferences.ftl src/modules/preferences.ts
git commit -m "feat: add Paper Pipeline Service section to preferences UI"
```

---

## Task 7: End-to-end test with Paper Pipeline Service

**Prerequisites:** Paper Pipeline Service running at `http://localhost:7070`

- [ ] **Step 1: Start Paper Pipeline Service**

```bash
cd ~/Documents/research-toolkit/paper_pipeline
python service.py
```

Verify: `curl http://localhost:7070/health` returns `{"services": {"mineru": "available"}, ...}`

- [ ] **Step 2: Build and install the plugin in Zotero**

```bash
cd ~/Documents/ZoFiles
npm run build
```

In Zotero: Tools → Add-ons → Install Add-on From File → select `builds/zofiles-*.xpi`

- [ ] **Step 3: Test arXiv paper export (LatexProvider)**

1. Add an arXiv paper to Zotero (e.g., search for "2404.12345")
2. Open ZoFiles preferences, verify service URL is `http://localhost:7070`
3. Click "Test Connection" — should show ✅
4. Click "Rebuild"
5. Check export folder: `{arxivId} - {title}/paper.latex` should exist

Expected: `paper.latex` contains valid LaTeX source.

- [ ] **Step 4: Test non-arXiv paper export (PipelinePdfProvider)**

1. Add a non-arXiv paper with PDF to Zotero
2. Click "Rebuild"
3. Check export folder: `paper.md` should appear within 1-10 minutes
4. Zotero notification should appear when conversion completes

Expected: `paper.md` contains Markdown with formula recognition.

- [ ] **Step 5: Test service unavailable warning**

1. Stop Paper Pipeline Service: `Ctrl+C` in the service terminal
2. Add a new arXiv paper to Zotero
3. Trigger export

Expected: Zotero alert dialog appears once with startup instructions. Other files (PDF, BibTeX, etc.) export normally.

---

## Task 8: Push and open PR

- [ ] **Step 1: Push branch**

```bash
cd ~/Documents/ZoFiles
git push -u origin feature/paper-pipeline-integration
```

- [ ] **Step 2: Open PR on GitHub**

```bash
gh pr create \
  --title "feat: replace MarkdownProvider with LatexProvider + PipelinePdfProvider" \
  --body "$(cat <<'EOF'
## Summary

- Removes `MarkdownProvider` (arxiv2md.org) and replaces with two new providers
- `LatexProvider`: fetches arXiv LaTeX source via local Paper Pipeline Service → `paper.latex`
- `PipelinePdfProvider`: converts non-arXiv PDFs via Paper Pipeline Service → `paper.md` (async background polling)
- Adds `pipelineServiceUrl` preference (default: `http://localhost:7070`) with test connection button
- Service unavailable alerts shown once per session to avoid spam

## Test plan

- [ ] arXiv paper exports `paper.latex` correctly
- [ ] Non-arXiv paper with PDF exports `paper.md` after async conversion
- [ ] Service unavailable shows alert once, other providers continue normally
- [ ] Test connection button shows ✅ / ❌ correctly
- [ ] Build passes with no TypeScript errors

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

*本计划由 Claude Sonnet 4.6 生成，基于 ZoFiles 源码分析和设计文档。*
