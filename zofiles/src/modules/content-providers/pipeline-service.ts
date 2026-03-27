/**
 * Shared utilities for providers that call the local Paper Pipeline Service.
 */

/**
 * One-time alert tracker: avoid spamming the user when batch-exporting
 * many papers and the service is down. Shared across all pipeline providers.
 */
let serviceAlertShownThisSession = false;

/**
 * Check Paper Pipeline Service health.
 * Returns true if service is reachable and MinerU is available.
 */
export async function checkServiceHealth(serviceUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${serviceUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const data = await response.json() as any;
    return data?.services?.mineru === "available";
  } catch {
    return false;
  }
}

/**
 * Show a one-per-session alert when the Paper Pipeline Service is unreachable.
 */
export function alertServiceUnavailable(serviceUrl: string): void {
  if (serviceAlertShownThisSession) return;
  serviceAlertShownThisSession = true;
  Zotero.alert(
    null as any,
    "ZoFiles — Paper Pipeline Service 不可用",
    `无法连接到 Paper Pipeline Service (${serviceUrl})。\n\n` +
      `请启动服务：\n` +
      `cd ~/Documents/research-toolkit/paper_pipeline\n` +
      `python service.py`,
  );
}
