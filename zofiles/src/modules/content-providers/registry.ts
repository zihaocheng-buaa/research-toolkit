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
