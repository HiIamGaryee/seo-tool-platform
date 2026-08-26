export type DomainCategory =
  | "Pending Delete"
  | "Redemption"
  | "Expired"
  | "Expiring <=30 Days"
  | "Expiring 31-60 Days"
  | "Safe"
  | "Unknown";

export type DomainPriority =
  | "Critical"
  | "Very High"
  | "High"
  | "Medium"
  | "Watch"
  | "Low"
  | "Unknown";

export type SpamLevel = "Low" | "Moderate" | "High" | "Very High";
export type RelevanceBand = "High" | "Medium" | "Low" | "None";
export type ScoreConfidence = "Full" | "Partial" | "Limited";

export type ScoreComponent = {
  key: string;
  label: string;
  weight: number;
  awarded: number | null;
  detail: string;
  available: boolean;
};

export type SpamSignal = {
  code: string;
  label: string;
  detail: string;
  points: number;
};

export type TopAnchor = {
  text: string;
  count: number;
  share_pct: number;
  kind: "branded" | "generic" | "exact_match" | "other";
};

export type ReferringDomain = {
  domain: string;
  backlinks: number | null;
  rating: number | string | null;
};

export type ArchiveSnapshot = {
  year: number | null;
  timestamp: string | null;
  title: string | null;
  meta_description: string | null;
  language: string | null;
  topic: string | null;
  is_redirect: boolean;
};

export type MetricHistoryPoint = {
  referring_domains: number | null;
  total_backlinks: number | null;
  spam_risk_score: number | null;
  seo_score: number | null;
  captured_at: string;
};

export type StatusHistoryPoint = {
  registry_status: string[];
  expiration_date: string | null;
  category: string | null;
  days_left: number | null;
  checked_at: string;
};

export type DomainRecord = {
  id: string;
  domain: string;
  tld: string;
  expiration_date: string | null;
  days_left: number | null;
  registry_status: string[];
  registrar: string | null;
  registration_date: string | null;
  nameservers: string[];
  category: DomainCategory;
  priority: DomainPriority;
  quality_score: number | null;
  available: boolean | null;
  lookup_status: string;
  lookup_error: string | null;
  rdap_source: string | null;
  source: string | null;
  first_seen: string | null;
  last_checked: string | null;

  /* SEO enrichment. Every metric is nullable — null means "not measured" and
     must render as an em dash, never as 0. */
  domain_age_years: number | null;
  backlink_provider: string | null;
  backlink_error: string | null;
  referring_domains: number | null;
  total_backlinks: number | null;
  follow_backlinks: number | null;
  nofollow_backlinks: number | null;
  lost_backlinks: number | null;
  new_backlinks: number | null;
  top_referring_domains: ReferringDomain[];
  top_referring_tlds: { tld: string; count: number }[];

  anchor_total: number | null;
  branded_pct: number | null;
  generic_pct: number | null;
  exact_match_pct: number | null;
  suspicious_anchor_pct: number | null;
  top_anchors: TopAnchor[];

  primary_topic: string | null;
  secondary_topics: string[];
  topic_match_count: number | null;
  topic_match_strength: string | null;
  historical_topic: string | null;
  topic_switch_count: number | null;
  historical_stability: string | null;
  relevance_score: number | null;
  relevance_band: RelevanceBand | null;

  first_archive_seen: string | null;
  last_archive_seen: string | null;
  snapshot_count: number | null;
  snapshot_count_truncated: boolean | null;
  archive_error: string | null;

  spam_risk_score: number | null;
  spam_risk_level: SpamLevel | null;
  spam_signals: SpamSignal[];
  spam_categories: string[];

  seo_base_score: number | null;
  spam_penalty: number | null;
  seo_score: number | null;
  seo_label: string | null;
  seo_confidence: ScoreConfidence | null;
  seo_coverage_pct: number | null;
  seo_unscored_reason: string | null;
  score_components: ScoreComponent[];
  score_reasons: string[];
  score_concerns: string[];

  watchlisted: boolean | null;
  notes: string | null;
  last_rdap_checked: string | null;
  last_backlink_checked: string | null;
  last_history_checked: string | null;
};

export type DomainDetail = DomainRecord & {
  snapshots: ArchiveSnapshot[];
  status_history: StatusHistoryPoint[];
  metric_history: MetricHistoryPoint[];
  discovery_sources: {
    source_name: string;
    source_kind: string | null;
    discovered_at: string;
    last_seen_source: string;
    seen_count: number;
  }[];
};

export type DiscoverySource = {
  id?: string;
  kind: string;
  name: string;
  label: string;
  status: "Active" | "Configured" | "Not Configured" | "Disabled" | "Failed";
  enabled: boolean;
  configured: boolean;
  source_url?: string;
  max_pages?: number;
  gemini_fallback?: boolean;
  detail: string;
  candidates: number | null;
  last_sync: string | null;
};

export type CrawlSourceForm = {
  id?: string;
  name: string;
  url: string;
  enabled: boolean;
  max_pages: number;
  css_selector: string;
  next_page_selector: string;
  use_gemini: boolean;
};

export type CrawlSourceTestResult = {
  status: string;
  pages: number;
  candidate_domains: number;
  sample: string[];
  error: string | null;
};

export type DiscoverySourcesResponse = {
  sources: DiscoverySource[];
  any_configured: boolean;
  enabled_kinds: string[];
  max_candidates: number;
  rdap_cache_hours: number;
  scan_batch_size: number;
  rdap_concurrency: number;
  warnings: string[];
};

export type SearchMode = "similar" | "exact" | "contains";
export type ExpiryWindow = 30 | 60;
export type VerificationSource = "rdap" | "whois" | "unknown";

export type LifecycleFilter =
  | "all"
  | "pending_delete"
  | "redemption"
  | "expired"
  | "lte_30"
  | "lte_60"
  | "low_spam";

export type SimilarDomainFilters = {
  keyword: string;
  search_mode: SearchMode;
  expiry_window: ExpiryWindow;
  tld: string | null;
  limit: number;
  lifecycle_filter: LifecycleFilter;
  include_available: boolean;
  /* Echoed back by the backend so a replayed search keeps the exact text the
     user typed — replaying `saibo898` instead of `saibo898.net` would lose the
     exact candidate. Never sent by the client. */
  raw_query?: string;
  entered_tld?: string | null;
  exact_candidate?: string | null;
};

export type ScorePart = { value: number; weight: number };

export type MatchLevel = "exact" | "strict" | "broader";

export type SimilarDomainResult = DomainRecord & {
  rank: number;
  final_rank_score: number;
  similarity_score: number;
  match_level: MatchLevel;
  match_level_label: string;
  exact_match: boolean;
  similarity_match_kind: string | null;
  similarity_second_level: string | null;
  similarity_tld_score: number | null;
  similarity_edit_distance: number | null;
  lifecycle_bucket: string;
  lifecycle_score: number;
  verification_source: VerificationSource;
  verified_from_cache: boolean;
  score_parts: { similarity: ScorePart; lifecycle: ScorePart; seo: ScorePart };
  source_names: string[];
  source_labels: string[];
};

export type SimilarSourceDetail = {
  name: string;
  kind: string;
  label: string;
  status: "success" | "error" | "not_configured";
  configured: boolean;
  searched: number;
  matched: number;
  duration_ms: number;
  error: string | null;
  detail: string;
};

/* Every count the backend tracked while narrowing the candidate pool. This is
   what turns an empty result set into an explanation. */
export type DiscoveryDiagnostics = {
  generated: number;
  source_matches: number;
  unique_candidates: number;
  skipped_over_cap: number;
  verify_attempted: number;
  rdap_verified: number;
  whois_verified: number;
  verified: number;
  cache_reused: number;
  lookup_failed: number;
  unsupported_tld: number;
  available_unregistered: number;
  no_expiry_data: number;
  safe_beyond_window: number;
  outside_expiry_window: number;
  below_similarity_floor: number;
  filtered_by_lifecycle: number;
  filtered_by_spam: number;
  eligible: number;
  seo_analyzed: number;
  level_exact: number;
  level_strict: number;
  level_broader: number;
  actionable: number;
  available: number;
  non_actionable: number;
  results: number;
};

/* A candidate that was verified but is not an opportunity: safe for years,
   no expiry published, or the lookup itself failed. */
export type NonActionableCandidate = {
  domain: string;
  reason: string;
  reason_code: string;
  detail: string;
  similarity_score: number;
  category: string | null;
  verification_source: VerificationSource;
  verification_status: "Verified" | "Unverified";
};

/* How the raw search box text was parsed. Proves no digits were dropped. */
export type ParsedQueryDebug = {
  raw_query: string;
  normalized_domain: string | null;
  second_level_domain: string;
  tld: string | null;
  is_full_domain: boolean;
  exact_candidate: string | null;
};

export type DiscoveryRejection = {
  domain: string;
  accepted: boolean;
  reason: string;
  detail: string;
  similarity_score: number;
  category: string | null;
  verification_source: VerificationSource;
};

/* Gemini telemetry. Counters and timings only — never a credential. */
export type GeminiRunStats = {
  configured: boolean;
  provider: string | null;
  model: string | null;
  reason: string | null;
  calls: number;
  success: number;
  failures: number;
  domains: number;
  last_status: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
};

export type SimilarSearchHistoryItem = {
  keyword: string;
  filters: Partial<SimilarDomainFilters>;
  result_count: number;
  searched_at: string;
};

export type SimilarDomainState = {
  run_id: string | null;
  status: "idle" | "running" | "completed" | "error";
  phase: string;
  keyword: string | null;
  filters: Partial<SimilarDomainFilters>;
  message: string | null;
  stage_label: string | null;
  sources_total: number;
  sources_completed: number;
  generated: number;
  source_matches: number;
  unique_candidates: number;
  verify_total: number;
  verified: number;
  eligible: number;
  enriched: number;
  seo_total: number;
  result_count: number;
  results: SimilarDomainResult[];
  available_results: SimilarDomainResult[];
  available_count: number;
  non_actionable: NonActionableCandidate[];
  non_actionable_count: number;
  query: Partial<ParsedQueryDebug>;
  strict_min_similarity: number;
  min_similarity: number;
  history: SimilarSearchHistoryItem[];
  source_counts: Record<string, number>;
  source_details: SimilarSourceDetail[];
  diagnostics: DiscoveryDiagnostics;
  rejections: DiscoveryRejection[];
  gemini: Partial<GeminiRunStats>;
  weights: { similarity: number; lifecycle: number; seo: number };
  tlds: string[];
  debug: boolean;
  no_sources_configured: boolean;
  cache_hit: boolean;
  cache_key: string | null;
  cache_expires_at: string | null;
  duration_ms: number | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
};

export type ProviderHealth = {
  status: string;
  detail: string;
};

export type ProviderStatusResponse = {
  rdap: ProviderHealth;
  whois: ProviderHealth;
  crawl4ai: ProviderHealth;
  gemini: ProviderHealth & {
    provider: string | null;
    model: string | null;
    calls: number;
    success: number;
    failures: number;
    last_status: string | null;
    last_error: string | null;
  };
  debug: boolean;
  tlds: string[];
  limits: { max_generated: number; max_verified: number; result_limit: number };
  fuzzy_backend: string;
};

export type GeminiTestResult = {
  status: "ok" | "error" | "not_configured";
  provider: string;
  model: string | null;
  latency_ms: number | null;
  http_status?: number;
  error: string | null;
  message: string | null;
};

export type SourceReport = {
  kind: string;
  name: string;
  label: string;
  status: string;
  configured: boolean;
  enabled: boolean;
  raw_count: number;
  detail: string;
  error: string | null;
};

export type DataSource = {
  key: string;
  label: string;
  status: string;
  available: boolean;
  detail: string;
};

export type EnrichmentState = {
  run_id: string | null;
  status: "idle" | "running" | "completed" | "error";
  phase: string;
  checked: number;
  total: number;
  with_backlinks: number;
  with_history: number;
  scored: number;
  unscored: number;
  high_opportunity: number;
  high_spam: number;
  failed: number;
  provider: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
};

export type DomainListResponse = {
  items: DomainRecord[];
  total: number;
  page: number;
  limit: number;
  pages: number;
};

export type ScanState = {
  scan_id: string | null;
  status: "idle" | "running" | "completed" | "error";
  phase: string;
  checked: number;
  total: number;
  collected: number;
  discovered: number;
  valid: number;
  unique: number;
  duplicates: number;
  invalid: number;
  truncated: boolean;
  skipped_cached: number;
  expired: number;
  expiring_30: number;
  expiring_31_60: number;
  redemption: number;
  pending_delete: number;
  unknown: number;
  failed: number;
  sources: Record<string, number>;
  source_reports: SourceReport[];
  no_sources_configured: boolean;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
};

export type DomainStatsResponse = {
  total: number;
  expired: number;
  expiring_30: number;
  expiring_31_60: number;
  redemption: number;
  pending_delete: number;
  safe: number;
  unknown: number;
  never_checked: number;
  lookup_failed: number;
  by_category: Record<string, number>;
  by_priority: Record<string, number>;
  tlds: { tld: string; count: number }[];
  last_checked: string | null;
  categories: string[];
  priorities: string[];
  scan: ScanState;

  high_opportunity: number;
  high_spam_risk: number;
  watchlisted: number;
  scored: number;
  with_backlink_data: number;
  with_history_data: number;
  high_opportunity_min: number;
  topics: { topic: string; count: number }[];
  refreshed: { rdap: string | null; backlinks: string | null; history: string | null };
  available_topics: string[];
  target_niches: string[];
  data_sources: DataSource[];
  discovery_sources: DiscoverySource[];
  source_candidates: Record<string, { candidates: number; last_sync: string | null }>;
  enrichment: EnrichmentState;
};

export type ImportResult = {
  imported: number;
  duplicates: number;
  invalid: number;
  invalid_samples: string[];
  total_lines_parsed: number;
};

export type DomainQuery = {
  search: string;
  category: string;
  priority: string;
  tld: string;
  status: string;
  days: string;
  seoMin: string;
  spamLevel: string;
  relevance: string;
  topic: string;
  referring: string;
  age: string;
  watchlisted: boolean;
  page: number;
  limit: number;
  sort: string;
  order: "asc" | "desc";
};

export const CATEGORY_TABS = [
  { label: "All", category: "" },
  { label: "Expired", category: "Expired" },
  { label: "≤30 Days", category: "Expiring <=30 Days" },
  { label: "31–60 Days", category: "Expiring 31-60 Days" },
  { label: "Redemption", category: "Redemption" },
  { label: "Pending Delete", category: "Pending Delete" },
] as const;

export const PRIORITY_OPTIONS = [
  "Critical",
  "Very High",
  "High",
  "Medium",
  "Watch",
] as const;

export const STATUS_OPTIONS = [
  { label: "Expired", value: "expired" },
  { label: "Redemption", value: "redemptionPeriod" },
  { label: "Pending Delete", value: "pendingDelete" },
  { label: "Active", value: "active" },
] as const;

export const DAYS_OPTIONS = [
  { label: "Expired", value: "expired" },
  { label: "0-30", value: "0-30" },
  { label: "31-60", value: "31-60" },
  { label: "60+", value: "60+" },
] as const;

export const SORT_COLUMNS = [
  { label: "Domain", key: "domain" },
  { label: "TLD", key: "tld" },
  { label: "Expiration Date", key: "expiration_date" },
  { label: "Days Left", key: "days_left" },
  { label: "Registry Status", key: "" },
  { label: "Registrar", key: "registrar" },
  { label: "Category", key: "category" },
  { label: "Priority", key: "priority" },
  { label: "Last Checked", key: "last_checked" },
  { label: "Action", key: "" },
] as const;

export const DEFAULT_QUERY: DomainQuery = {
  search: "",
  category: "",
  priority: "",
  tld: "",
  status: "",
  days: "",
  seoMin: "",
  spamLevel: "",
  relevance: "",
  topic: "",
  referring: "",
  age: "",
  watchlisted: false,
  page: 1,
  limit: 20,
  sort: "seo_score",
  order: "desc",
};

export const SEO_SCORE_OPTIONS = [
  { label: "90+", value: "90" },
  { label: "80+", value: "80" },
  { label: "70+", value: "70" },
  { label: "60+", value: "60" },
] as const;

export const SPAM_LEVEL_OPTIONS = ["Low", "Moderate", "High", "Very High"] as const;

export const RELEVANCE_OPTIONS = ["High", "Medium", "Low"] as const;

export const REFERRING_OPTIONS = [
  { label: "0–10", value: "0-10" },
  { label: "11–50", value: "11-50" },
  { label: "51–100", value: "51-100" },
  { label: "100+", value: "100+" },
] as const;

export const AGE_OPTIONS = [
  { label: "< 1 year", value: "<1" },
  { label: "1–3 years", value: "1-3" },
  { label: "3–5 years", value: "3-5" },
  { label: "5–10 years", value: "5-10" },
  { label: "10+ years", value: "10+" },
] as const;

export function hasActiveFilters(query: DomainQuery): boolean {
  return (
    [
      "search",
      "category",
      "priority",
      "tld",
      "status",
      "days",
      "seoMin",
      "spamLevel",
      "relevance",
      "topic",
      "referring",
      "age",
    ] as const
  ).some((key) => Boolean(query[key])) || query.watchlisted;
}

export function formatDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatDaysLeft(days: number | null): string {
  if (days === null || days === undefined) return "—";
  return String(days);
}
