import axios from "axios";
import type {
  CrawlSourceForm,
  CrawlSourceTestResult,
  DataSource,
  DiscoverySourcesResponse,
  DomainDetail,
  DomainListResponse,
  DomainQuery,
  DomainRecord,
  DomainStatsResponse,
  EnrichmentState,
  GeminiTestResult,
  ImportResult,
  ProviderStatusResponse,
  ScanState,
  SimilarDomainFilters,
  SimilarDomainState,
  SimilarSearchHistoryItem,
} from "./types";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

const BASE = `${API_BASE_URL}/api/domain-monitor`;
const REQUEST_TIMEOUT_MS = 20000;

/* Mirrors DOMAIN_RADAR_DEBUG on the backend. Only ever gates diagnostics:
   no credential is readable from the frontend, so none can be logged. */
export const DEBUG =
  String(import.meta.env.VITE_DOMAIN_RADAR_DEBUG ?? "").toLowerCase() === "true";

export function debugLog(label: string, payload?: Record<string, unknown>) {
  if (!DEBUG) return;
  if (payload === undefined) console.log(`[DomainRadar] ${label}`);
  else console.log(`[DomainRadar] ${label}`, payload);
}

/* One request/response line per API call, with counts rather than payloads. */
async function traced<T>(
  method: string,
  path: string,
  call: () => Promise<{ data: T; status: number }>,
  summarize?: (data: T) => Record<string, unknown>,
): Promise<T> {
  if (!DEBUG) return (await call()).data;
  const started = performance.now();
  try {
    const response = await call();
    const duration = performance.now() - started;
    console.log(`[DomainRadar API] ${method} ${path}`, {
      status: response.status,
      duration: `${(duration / 1000).toFixed(2)}s`,
      ...(summarize?.(response.data) ?? {}),
    });
    return response.data;
  } catch (caught) {
    const duration = performance.now() - started;
    console.warn(`[DomainRadar API] ${method} ${path} failed`, {
      duration: `${(duration / 1000).toFixed(2)}s`,
      message: errorMessage(caught),
    });
    throw caught;
  }
}

/* Only the filter keys the backend whitelists, with empties dropped. */
/* Frontend camelCase maps onto the backend's snake_case query names here, in
   one place, so no component has to know the wire format. */
const FILTER_KEYS: [keyof DomainQuery, string][] = [
  ["search", "search"],
  ["category", "category"],
  ["priority", "priority"],
  ["tld", "tld"],
  ["status", "status"],
  ["days", "days"],
  ["seoMin", "seo_min"],
  ["spamLevel", "spam_level"],
  ["relevance", "relevance"],
  ["topic", "topic"],
  ["referring", "referring"],
  ["age", "age"],
  ["sort", "sort"],
  ["order", "order"],
];

function filterParams(query: Partial<DomainQuery>): Record<string, string> {
  const params: Record<string, string> = {};
  FILTER_KEYS.forEach(([key, wire]) => {
    const value = query[key];
    if (value !== undefined && value !== null && String(value) !== "") {
      params[wire] = String(value);
    }
  });
  if (query.watchlisted) params.watchlisted = "true";
  return params;
}

export async function fetchDomains(
  query: DomainQuery,
  signal?: AbortSignal,
): Promise<DomainListResponse> {
  const response = await axios.get<DomainListResponse>(BASE, {
    params: { ...filterParams(query), page: query.page, limit: query.limit },
    timeout: REQUEST_TIMEOUT_MS,
    signal,
  });
  return response.data;
}

export async function fetchStats(signal?: AbortSignal): Promise<DomainStatsResponse> {
  const response = await axios.get<DomainStatsResponse>(`${BASE}/stats`, {
    timeout: REQUEST_TIMEOUT_MS,
    signal,
  });
  return response.data;
}

export async function fetchDomain(domain: string): Promise<DomainDetail> {
  const response = await axios.get<DomainDetail>(
    `${BASE}/${encodeURIComponent(domain)}`,
    { timeout: REQUEST_TIMEOUT_MS },
  );
  return response.data;
}

export async function fetchOpportunities(
  limit = 6,
  signal?: AbortSignal,
): Promise<DomainRecord[]> {
  const response = await axios.get<{ items: DomainRecord[] }>(`${BASE}/opportunities`, {
    params: { limit },
    timeout: REQUEST_TIMEOUT_MS,
    signal,
  });
  return response.data.items;
}

export async function fetchDataSources(signal?: AbortSignal): Promise<DataSource[]> {
  const response = await axios.get<{ sources: DataSource[] }>(`${BASE}/data-sources`, {
    timeout: REQUEST_TIMEOUT_MS,
    signal,
  });
  return response.data.sources;
}

export type EnrichOptions = {
  force?: boolean;
  limit?: number | null;
  domains?: string[];
  includeSafe?: boolean;
};

export async function startEnrichment(
  options: EnrichOptions = {},
): Promise<EnrichmentState & { started: boolean; reason?: string }> {
  const params: Record<string, string | number | boolean> = {
    force: options.force ?? false,
  };
  if (options.limit) params.limit = options.limit;
  if (options.domains?.length) params.domains = options.domains.join(",");
  if (options.includeSafe) params.include_safe = true;

  const response = await axios.post<EnrichmentState & { started: boolean; reason?: string }>(
    `${BASE}/enrich`,
    null,
    { params, timeout: REQUEST_TIMEOUT_MS },
  );
  return response.data;
}

export async function fetchEnrichmentState(signal?: AbortSignal): Promise<EnrichmentState> {
  const response = await axios.get<EnrichmentState>(`${BASE}/enrich`, {
    timeout: REQUEST_TIMEOUT_MS,
    signal,
  });
  return response.data;
}

export async function saveTargetNiches(
  niches: string[],
): Promise<{ target_niches: string[]; ignored: string[] }> {
  const response = await axios.put<{ target_niches: string[]; ignored: string[] }>(
    `${BASE}/settings`,
    { target_niches: niches },
    { timeout: REQUEST_TIMEOUT_MS },
  );
  return response.data;
}

export async function setWatchlist(
  domain: string,
  watchlisted: boolean,
  notes?: string | null,
): Promise<DomainRecord> {
  const response = await axios.post<DomainRecord>(
    `${BASE}/watchlist`,
    { domain, watchlisted, ...(notes === undefined ? {} : { notes }) },
    { timeout: REQUEST_TIMEOUT_MS },
  );
  return response.data;
}

export async function compareDomains(
  domains: string[],
): Promise<{ items: DomainRecord[]; missing: string[] }> {
  const response = await axios.get<{ items: DomainRecord[]; missing: string[] }>(
    `${BASE}/compare`,
    { params: { domains: domains.join(",") }, timeout: REQUEST_TIMEOUT_MS },
  );
  return response.data;
}

export async function fetchDiscoverySources(
  signal?: AbortSignal,
): Promise<DiscoverySourcesResponse> {
  const response = await axios.get<DiscoverySourcesResponse>(`${BASE}/sources`, {
    timeout: REQUEST_TIMEOUT_MS,
    signal,
  });
  return response.data;
}

export async function testCrawlSource(
  payload: CrawlSourceForm,
): Promise<CrawlSourceTestResult> {
  const response = await axios.post<CrawlSourceTestResult>(
    `${BASE}/sources/crawl4ai/test`,
    payload,
    { timeout: 60000 },
  );
  return response.data;
}

export async function saveCrawlSource(
  payload: CrawlSourceForm,
): Promise<{ source: CrawlSourceForm }> {
  const response = await axios.post<{ source: CrawlSourceForm }>(
    `${BASE}/sources/crawl4ai`,
    payload,
    { timeout: REQUEST_TIMEOUT_MS },
  );
  return response.data;
}

export async function refreshCrawlSources(
  sourceId?: string,
): Promise<{ results: Array<Record<string, unknown>> }> {
  const response = await axios.post<{ results: Array<Record<string, unknown>> }>(
    `${BASE}/sources/crawl4ai/refresh`,
    sourceId ? { source_id: sourceId } : {},
    { timeout: 120000 },
  );
  return response.data;
}

export async function discoverSimilarDomains(
  payload: SimilarDomainFilters,
): Promise<SimilarDomainState & { started: boolean; reason?: string }> {
  debugLog("Search started", {
    keyword: payload.keyword,
    mode: payload.search_mode,
    expiryWindow: payload.expiry_window,
    tld: payload.tld ?? "any",
    lifecycle: payload.lifecycle_filter,
    includeAvailable: payload.include_available,
  });
  return traced(
    "POST",
    "/api/domain-monitor/discover-keyword",
    () =>
      axios.post<SimilarDomainState & { started: boolean; reason?: string }>(
        `${BASE}/discover-keyword`,
        payload,
        { timeout: 60000 },
      ),
    (data) => ({ started: data.started, phase: data.phase }),
  );
}

export async function fetchSimilarDomainState(
  signal?: AbortSignal,
): Promise<SimilarDomainState> {
  const response = await axios.get<SimilarDomainState>(`${BASE}/discover-keyword`, {
    timeout: REQUEST_TIMEOUT_MS,
    signal,
  });
  return response.data;
}

export async function fetchSimilarSearchHistory(
  signal?: AbortSignal,
): Promise<SimilarSearchHistoryItem[]> {
  const response = await axios.get<{ items: SimilarSearchHistoryItem[] }>(
    `${BASE}/discover-keyword/history`,
    { timeout: REQUEST_TIMEOUT_MS, signal },
  );
  return response.data.items;
}

export async function exportSimilarDomains(
  cacheKey: string,
  fmt: "csv" | "xlsx" = "csv",
): Promise<Blob> {
  const response = await axios.get<Blob>(`${BASE}/discover-keyword/export`, {
    params: { cache_key: cacheKey, fmt },
    responseType: "blob",
    timeout: 60000,
  });
  return response.data;
}

export async function clearSimilarSearchHistory(): Promise<{ cleared: number }> {
  const response = await axios.delete<{ cleared: number }>(
    `${BASE}/discover-keyword/history`,
    { timeout: REQUEST_TIMEOUT_MS },
  );
  return response.data;
}

export async function fetchProviderStatus(
  signal?: AbortSignal,
): Promise<ProviderStatusResponse> {
  const response = await axios.get<ProviderStatusResponse>(`${BASE}/provider-status`, {
    timeout: REQUEST_TIMEOUT_MS,
    signal,
  });
  return response.data;
}

/* Connectivity is tested on the backend. The key never reaches the browser,
   so this request carries no credential and the reply carries no secret. */
export async function testGemini(): Promise<GeminiTestResult> {
  return traced(
    "POST",
    "/api/domain-monitor/gemini/test",
    () => axios.post<GeminiTestResult>(`${BASE}/gemini/test`, null, { timeout: 30000 }),
    (data) => ({ status: data.status, latency: data.latency_ms }),
  );
}

export type ScanOptions = {
  force?: boolean;
  useSources?: boolean;
  limit?: number | null;
  domains?: string[];
  sources?: string[];
  enrich?: boolean;
};

export async function startScan(
  options: ScanOptions = {},
): Promise<ScanState & { started: boolean; reason?: string }> {
  const params: Record<string, string | number | boolean> = {
    force: options.force ?? false,
    use_sources: options.useSources ?? true,
  };
  if (options.limit) params.limit = options.limit;
  if (options.domains?.length) params.domains = options.domains.join(",");
  if (options.sources?.length) params.sources = options.sources.join(",");
  if (options.enrich) params.enrich = true;

  const response = await axios.post<ScanState & { started: boolean; reason?: string }>(
    `${BASE}/scan`,
    null,
    { params, timeout: REQUEST_TIMEOUT_MS },
  );
  return response.data;
}

export async function fetchScanState(signal?: AbortSignal): Promise<ScanState> {
  const response = await axios.get<ScanState>(`${BASE}/scan`, {
    timeout: REQUEST_TIMEOUT_MS,
    signal,
  });
  return response.data;
}

export async function importDomains(file: File): Promise<ImportResult> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await axios.post<ImportResult>(`${BASE}/import`, formData, {
    headers: { "Content-Type": "multipart/form-data" },
    timeout: 60000,
  });
  return response.data;
}

export async function importDomainText(text: string): Promise<ImportResult> {
  const file = new File([text], "pasted-domains.txt", { type: "text/plain" });
  return importDomains(file);
}

export async function exportDomains(
  query: DomainQuery,
  fmt: "csv" | "xlsx" = "csv",
): Promise<Blob> {
  const response = await axios.get<Blob>(`${BASE}/export`, {
    params: { ...filterParams(query), fmt },
    responseType: "blob",
    timeout: 60000,
  });
  return response.data;
}

export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data as { error?: string; detail?: string } | undefined;
    return detail?.error || detail?.detail || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
