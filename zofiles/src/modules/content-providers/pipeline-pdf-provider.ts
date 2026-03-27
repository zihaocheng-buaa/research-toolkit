import { BaseProvider, ExportContext, ProviderResult } from "./provider";
import { joinPath } from "../utils";
import { getPref } from "../../utils/prefs";
import { checkServiceHealth, alertServiceUnavailable } from "./pipeline-service";

// Polling interval: 15 seconds
const POLL_INTERVAL_MS = 15_000;
// Timeout: 20 minutes
const POLL_TIMEOUT_MS = 20 * 60 * 1000;

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
      let pdfPath: string | false = false;
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

      const serviceUrl = getPref("pipelineServiceUrl") || "http://localhost:7070";

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

      const submitData = await submitResponse.json() as any;
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
      const intervalId = (Zotero as any).setInterval(async () => {
        // Timeout check
        if (Date.now() - startTime > POLL_TIMEOUT_MS) {
          (Zotero as any).clearInterval(intervalId);
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

          const statusData = await statusResponse.json() as any;
          const status = statusData.status;

          if (status === "done") {
            (Zotero as any).clearInterval(intervalId);
            if (statusData.markdown) {
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
            } else {
              new ztoolkit.ProgressWindow("ZoFiles")
                .createLine({
                  text: `PDF 转换完成但无内容：${ctx.item.getField("title")}`,
                  type: "fail",
                })
                .show()
                .startCloseTimer(5000);
            }
          } else if (status === "failed") {
            (Zotero as any).clearInterval(intervalId);
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
