import { BaseProvider, ExportContext, ProviderResult } from "./provider";
import { joinPath } from "../utils";
import { getPref } from "../../utils/prefs";
import { checkServiceHealth, alertServiceUnavailable } from "./pipeline-service";

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
        return { success: true, files: [targetPath], linkBack: true };
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

      const data = await response.json() as any;

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
