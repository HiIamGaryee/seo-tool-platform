import { useEffect, useMemo, useRef, useState } from "react"
import { Bug, ChevronRight, Download, Search, Star } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

import {
  clearSimilarSearchHistory,
  debugLog,
  discoverSimilarDomains,
  errorMessage,
  exportSimilarDomains,
  fetchSimilarDomainState,
  fetchSimilarSearchHistory,
} from "./api"
import DiscoveryDebugSheet from "./DiscoveryDebugSheet"
import { categoryBadgeClass, categoryLabel, spamBadgeClass } from "./domainVisuals"
import MetricValue from "./MetricValue"
import type {
  DomainRecord,
  MatchLevel,
  SearchMode,
  SimilarDomainFilters,
  SimilarDomainResult,
  SimilarDomainState,
  SimilarSearchHistoryItem,
} from "./types"
import { formatDate } from "./types"

const POLL_MS = 1500

const DEFAULT_FILTERS: SimilarDomainFilters = {
  keyword: "",
  search_mode: "similar",
  expiry_window: 60,
  tld: null,
  limit: 30,
  lifecycle_filter: "all",
  include_available: false,
}

const SEARCH_MODES = [
  { label: "Similar", value: "similar", hint: "Full discovery pipeline" },
  { label: "Exact", value: "exact", hint: "Exact name across every TLD" },
  { label: "Contains", value: "contains", hint: "Configured sources only" },
] as const

const EXPIRY_WINDOWS = [
  { label: "30 Days", value: 30 },
  { label: "60 Days", value: 60 },
] as const

const TLD_OPTIONS = ["any", ".com", ".net", ".org", ".co", ".io", ".ai", ".my", ".sg"] as const

const RESULT_LIMITS = [10, 20, 30] as const

const LIFECYCLE_FILTERS = [
  { label: "All", value: "all" },
  { label: "Pending Delete", value: "pending_delete" },
  { label: "Redemption", value: "redemption" },
  { label: "Expired", value: "expired" },
  { label: "≤30 Days", value: "lte_30" },
  { label: "≤60 Days", value: "lte_60" },
  { label: "Low Spam Only", value: "low_spam" },
] as const

const SORT_OPTIONS = [
  { label: "Recommended", value: "recommended" },
  { label: "Similarity", value: "similarity" },
  { label: "Lifecycle Urgency", value: "lifecycle" },
  { label: "SEO Score", value: "seo_score" },
  { label: "Expiry", value: "expiry" },
  { label: "Referring Domains", value: "referring_domains" },
] as const

/* The stages the backend actually reports, in pipeline order. Every row shows a
   real count, so nothing here advances on a timer. */
const STAGES = [
  {
    phase: "generating",
    label: "Generating candidates",
    value: (s: SimilarDomainState) => s.generated.toLocaleString(),
  },
  {
    phase: "searching_sources",
    label: "Source matches",
    value: (s: SimilarDomainState) => s.source_matches.toLocaleString(),
  },
  {
    phase: "deduplicating",
    label: "Unique candidates",
    value: (s: SimilarDomainState) => s.unique_candidates.toLocaleString(),
  },
  {
    phase: "verifying",
    label: "RDAP / WHOIS",
    value: (s: SimilarDomainState) => `${s.verified} / ${s.verify_total}`,
  },
  {
    phase: "lifecycle_filter",
    label: "Lifecycle eligible",
    value: (s: SimilarDomainState) => `${s.eligible}`,
  },
  {
    phase: "seo_analysis",
    label: "SEO enrichment",
    value: (s: SimilarDomainState) => `${s.enriched} / ${s.seo_total}`,
  },
  {
    phase: "ranking",
    label: "Ranking",
    value: (s: SimilarDomainState) => `${s.result_count}`,
  },
] as const

const PHASE_ORDER = STAGES.map((stage) => stage.phase)

const ZERO_RESULT_ROWS = [
  { key: "generated", label: "Candidates generated" },
  { key: "verify_attempted", label: "RDAP / WHOIS checked" },
  { key: "safe_beyond_window", label: "Safe beyond the window" },
  { key: "available_unregistered", label: "Available / unregistered" },
  { key: "no_expiry_data", label: "No expiry published" },
  { key: "lookup_failed", label: "Lookup failed" },
  { key: "unsupported_tld", label: "Unsupported TLD" },
] as const

const LIFECYCLE_URGENCY: Record<string, number> = {
  "Pending Delete": 100,
  Redemption: 90,
  Expired: 80,
  "Expiring <=30 Days": 70,
  "Expiring 31-60 Days": 50,
  Safe: 0,
  Unknown: 0,
}

const VERIFIED_LABEL: Record<string, string> = {
  rdap: "RDAP",
  whois: "WHOIS",
  unknown: "—",
}

const LEVEL_TONE: Record<MatchLevel, string> = {
  exact: "border-primary/60 text-primary",
  strict: "text-muted-foreground",
  broader: "text-caution",
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/* Broader matches never sort above strict ones, whatever the chosen column. */
function sortResults(results: SimilarDomainResult[], sortBy: string) {
  const levelRank: Record<string, number> = { exact: 0, strict: 1, broader: 2 }
  const rows = [...results]
  rows.sort((a, b) => {
    const byLevel = (levelRank[a.match_level] ?? 2) - (levelRank[b.match_level] ?? 2)
    if (byLevel !== 0) return byLevel
    if (sortBy === "similarity") return b.similarity_score - a.similarity_score
    if (sortBy === "seo_score") return (b.seo_score ?? -1) - (a.seo_score ?? -1)
    if (sortBy === "lifecycle") {
      return (LIFECYCLE_URGENCY[b.category] ?? 0) - (LIFECYCLE_URGENCY[a.category] ?? 0)
    }
    if (sortBy === "expiry") {
      return (
        (a.days_left ?? Number.MAX_SAFE_INTEGER) - (b.days_left ?? Number.MAX_SAFE_INTEGER)
      )
    }
    if (sortBy === "referring_domains") {
      return (b.referring_domains ?? -1) - (a.referring_domains ?? -1)
    }
    return (b.final_rank_score ?? 0) - (a.final_rank_score ?? 0)
  })
  return rows.map((row, index) => ({ ...row, rank: index + 1 }))
}

/* One collapsed row. Everything secondary on this page uses it, so the page
   reads as a short list of headings until something is opened. */
function Section({
  title,
  summary,
  count,
  defaultOpen = false,
  action,
  children,
}: {
  title: string
  summary?: string
  count?: number
  defaultOpen?: boolean
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="rounded-lg border">
      <div className="flex items-center gap-2 pr-2">
        <CollapsibleTrigger className="group flex flex-1 items-center gap-2 px-3 py-2.5 text-left [&[data-state=open]>svg]:rotate-90">
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform duration-200" />
          <span className="text-sm font-medium">
            {title}
            {count !== undefined && (
              <span className="ml-1 text-muted-foreground">({count})</span>
            )}
          </span>
          {summary && (
            <span className="truncate text-xs text-muted-foreground">{summary}</span>
          )}
        </CollapsibleTrigger>
        {action}
      </div>
      <CollapsibleContent>
        <Separator />
        <div className="px-3 py-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular font-medium text-foreground">{value}</span>
    </div>
  )
}

function StageList({ state }: { state: SimilarDomainState }) {
  const activeIndex = PHASE_ORDER.indexOf(state.phase as (typeof PHASE_ORDER)[number])
  const isDone = state.status === "completed"
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {STAGES.map((stage, index) => {
        const reached = isDone || (activeIndex >= 0 && index <= activeIndex)
        const active = !isDone && index === activeIndex
        return (
          <div
            key={stage.phase}
            className={cn(
              "flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm",
              active
                ? "border-primary/50 bg-primary/5"
                : reached
                  ? "border-border bg-muted/30"
                  : "border-dashed border-border",
            )}
          >
            <span className="text-muted-foreground">{stage.label}</span>
            <span className="tabular font-medium text-foreground">
              {reached ? stage.value(state) : "—"}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function ResultTable({
  rows,
  showLifecycle,
  onView,
  onToggleWatchlist,
}: {
  rows: SimilarDomainResult[]
  showLifecycle: boolean
  onView: (record: DomainRecord) => void
  onToggleWatchlist: (record: DomainRecord) => void
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Rank</TableHead>
            <TableHead>Domain</TableHead>
            <TableHead>Similarity</TableHead>
            {showLifecycle && <TableHead>Lifecycle</TableHead>}
            <TableHead>Expiry</TableHead>
            <TableHead>Days Left</TableHead>
            <TableHead>RD</TableHead>
            <TableHead>Spam Risk</TableHead>
            <TableHead>SEO Score</TableHead>
            <TableHead>Verified By</TableHead>
            <TableHead className="w-44">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((record) => (
            <TableRow key={`${record.domain}-${record.rank}`}>
              <TableCell className="tabular font-medium">#{record.rank}</TableCell>
              <TableCell>
                <button type="button" onClick={() => onView(record)} className="text-left">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground hover:underline">
                      {record.domain}
                    </span>
                    {record.exact_match && (
                      <Badge variant="outline" className={cn("text-[10px]", LEVEL_TONE.exact)}>
                        Exact
                      </Badge>
                    )}
                    {record.match_level === "broader" && (
                      <Badge
                        variant="outline"
                        className={cn("text-[10px]", LEVEL_TONE.broader)}
                      >
                        Broader Match
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {record.source_labels.map((label) => (
                      <Badge
                        key={`${record.domain}-${label}`}
                        variant="outline"
                        className="text-[10px]"
                      >
                        {label}
                      </Badge>
                    ))}
                  </div>
                </button>
              </TableCell>
              <TableCell className="tabular font-medium">
                {record.similarity_score}%
              </TableCell>
              {showLifecycle && (
                <TableCell>
                  <Badge className={cn("font-medium", categoryBadgeClass(record.category))}>
                    {categoryLabel(record.category)}
                  </Badge>
                </TableCell>
              )}
              <TableCell>{formatDate(record.expiration_date)}</TableCell>
              <TableCell className="tabular">{record.days_left ?? "—"}</TableCell>
              <TableCell>
                <MetricValue value={record.referring_domains} />
              </TableCell>
              <TableCell>
                <Badge className={cn("font-medium", spamBadgeClass(record.spam_risk_level))}>
                  {record.spam_risk_level ?? "—"}
                </Badge>
              </TableCell>
              <TableCell className="tabular font-medium">
                {record.seo_score ?? "—"}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {VERIFIED_LABEL[record.verification_source] ?? "—"}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => onView(record)}>
                    View
                  </Button>
                  <Button
                    size="sm"
                    variant={record.watchlisted ? "secondary" : "ghost"}
                    onClick={() => onToggleWatchlist(record)}
                  >
                    <Star className={cn("size-4", record.watchlisted && "fill-current")} />
                    {record.watchlisted ? "Watchlisted" : "Watchlist"}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function SimilarDomainPanel({
  onView,
  onToggleWatchlist,
  onConfigureSources,
}: {
  onView: (record: DomainRecord) => void
  onToggleWatchlist: (record: DomainRecord) => void
  onConfigureSources: () => void
}) {
  const [filters, setFilters] = useState<SimilarDomainFilters>(DEFAULT_FILTERS)
  const [keywordInput, setKeywordInput] = useState("")
  const [sortBy, setSortBy] = useState("recommended")
  const [history, setHistory] = useState<SimilarSearchHistoryItem[]>([])
  const [state, setState] = useState<SimilarDomainState | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isDebugOpen, setIsDebugOpen] = useState(false)
  const loggedPhase = useRef<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchSimilarSearchHistory(controller.signal)
      .then(setHistory)
      .catch(() => undefined)
    fetchSimilarDomainState(controller.signal)
      .then(setState)
      .catch(() => undefined)
    return () => controller.abort()
  }, [])

  /* One console line per stage transition, so the browser console reads as the
     pipeline rather than as a poll loop. */
  useEffect(() => {
    if (!state || loggedPhase.current === state.phase) return
    loggedPhase.current = state.phase
    const labels: Record<string, string> = {
      generating: "Candidate generation",
      searching_sources: "Source matches",
      deduplicating: "Unique candidates",
      verifying: "RDAP progress",
      lifecycle_filter: "Lifecycle eligible",
      seo_analysis: "SEO analyzed",
      ranking: "Ranking",
    }
    const byPhase: Record<string, Record<string, unknown>> = {
      generating: {
        raw_query: state.query?.raw_query,
        normalized_domain: state.query?.normalized_domain,
        second_level_domain: state.query?.second_level_domain,
        tld: state.query?.tld,
        exact_candidate: state.query?.exact_candidate,
        generated_candidate_count: state.generated,
      },
      searching_sources: {
        found: state.source_matches,
        sources: `${state.sources_completed}/${state.sources_total}`,
      },
      deduplicating: { total: state.unique_candidates },
      verifying: { progress: `${state.verified} / ${state.verify_total}` },
      lifecycle_filter: { eligible: state.eligible },
      seo_analysis: { analyzed: `${state.enriched} / ${state.seo_total}` },
      ranking: { candidates: state.eligible },
    }
    if (labels[state.phase]) debugLog(labels[state.phase], byPhase[state.phase])
  }, [state])

  useEffect(() => {
    if (state?.status !== "running") return
    const interval = window.setInterval(async () => {
      try {
        const next = await fetchSimilarDomainState()
        setState(next)
        if (next.status !== "running") {
          window.clearInterval(interval)
          setIsSubmitting(false)
          setHistory(next.history)
          debugLog("Search completed", {
            results: next.result_count,
            available: next.available_count,
            nonActionable: next.non_actionable_count,
            duration: next.duration_ms ? `${(next.duration_ms / 1000).toFixed(1)}s` : "—",
            diagnostics: next.diagnostics,
          })
          if (next.gemini?.calls) {
            debugLog("Gemini", {
              configured: next.gemini.configured,
              provider: next.gemini.provider,
              model: next.gemini.model,
              calls: next.gemini.calls,
              success: next.gemini.success,
              failures: next.gemini.failures,
              extractedDomains: next.gemini.domains,
            })
          } else if (next.gemini && next.gemini.configured === false) {
            debugLog("Gemini not configured", { reason: next.gemini.reason })
          }
          if (next.error) {
            toast.error("Discovery failed", { description: next.error })
          }
        }
      } catch (caught) {
        window.clearInterval(interval)
        setIsSubmitting(false)
        toast.error("Lost track of the discovery run", {
          description: errorMessage(caught),
        })
      }
    }, POLL_MS)
    return () => window.clearInterval(interval)
  }, [state?.status])

  const results = useMemo(
    () => sortResults(state?.results ?? [], sortBy),
    [sortBy, state?.results],
  )

  const handleDiscover = async (override?: Partial<SimilarDomainFilters>) => {
    const payload: SimilarDomainFilters = {
      ...filters,
      ...override,
      keyword: (override?.keyword ?? keywordInput).trim(),
    }
    setKeywordInput(payload.keyword)
    setFilters(payload)
    setIsSubmitting(true)
    loggedPhase.current = null
    debugLog("Search started", { raw_query: payload.keyword, mode: payload.search_mode })
    try {
      const response = await discoverSimilarDomains(payload)
      setState(response)
      setHistory(response.history)
      if (!response.started) {
        setIsSubmitting(false)
        toast[response.no_sources_configured ? "warning" : "info"](
          response.reason ?? (response.cache_hit ? "Loaded a cached run" : "Discovery ready"),
        )
      }
    } catch (caught) {
      setIsSubmitting(false)
      toast.error("Discovery failed", { description: errorMessage(caught) })
    }
  }

  const handleClearHistory = async () => {
    try {
      await clearSimilarSearchHistory()
      setHistory([])
      toast.success("Search history cleared")
    } catch (caught) {
      toast.error("Could not clear history", { description: errorMessage(caught) })
    }
  }

  const handleExport = async (fmt: "csv" | "xlsx") => {
    if (!state?.cache_key) return
    setIsExporting(true)
    try {
      const blob = await exportSimilarDomains(state.cache_key, fmt)
      downloadBlob(blob, `similar-domains.${fmt}`)
      toast.success("Export ready", { description: `similar-domains.${fmt}` })
    } catch (caught) {
      toast.error("Export failed", { description: errorMessage(caught) })
    } finally {
      setIsExporting(false)
    }
  }

  const isRunning = state?.status === "running"
  const isComplete = state?.status === "completed"
  const showDebug = Boolean(state?.debug)
  const diagnostics = state?.diagnostics
  const available = state?.available_results ?? []
  const nonActionable = state?.non_actionable ?? []

  const modeLabel =
    SEARCH_MODES.find((mode) => mode.value === filters.search_mode)?.label ?? "Similar"
  const advancedSummary = [
    modeLabel,
    `${filters.expiry_window} Days`,
    filters.tld ?? "Any TLD",
    `Top ${filters.limit}`,
    filters.include_available ? "Include Available" : null,
  ]
    .filter(Boolean)
    .join(" · ")

  const diagnosticsSummary = diagnostics
    ? `${diagnostics.unique_candidates.toLocaleString()} candidates · ${diagnostics.verify_attempted.toLocaleString()} verified · ${diagnostics.eligible} eligible`
    : undefined

  return (
    <Card>
      <CardHeader className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>Similar Domain Discovery</CardTitle>
            <CardDescription>
              Find expired or expiring domains similar to your keyword.
            </CardDescription>
          </div>
          {showDebug && (
            <Button size="sm" variant="outline" onClick={() => setIsDebugOpen(true)}>
              <Bug className="size-4" />
              Debug
            </Button>
          )}
        </div>

        <div className="flex flex-col gap-3 md:flex-row">
          <Input
            value={keywordInput}
            onChange={(event) => setKeywordInput(event.target.value)}
            placeholder="Keyword or full domain, e.g. saibo898 or saibo898.net"
            className="flex-1"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !isSubmitting) void handleDiscover()
            }}
          />
          <Button onClick={() => void handleDiscover()} disabled={isSubmitting || isRunning}>
            <Search className="size-4" />
            {isRunning ? "Discovering..." : "Discover Domains"}
          </Button>
        </div>

        <Section title="Advanced Search Options" summary={advancedSummary}>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-md border border-border p-0.5">
                {SEARCH_MODES.map((mode) => (
                  <Button
                    key={mode.value}
                    size="sm"
                    variant={filters.search_mode === mode.value ? "secondary" : "ghost"}
                    title={mode.hint}
                    onClick={() =>
                      setFilters((current) => ({
                        ...current,
                        search_mode: mode.value as SearchMode,
                      }))
                    }
                  >
                    {mode.label}
                  </Button>
                ))}
              </div>

              <div className="inline-flex rounded-md border border-border p-0.5">
                {EXPIRY_WINDOWS.map((window) => (
                  <Button
                    key={window.value}
                    size="sm"
                    variant={filters.expiry_window === window.value ? "secondary" : "ghost"}
                    onClick={() =>
                      setFilters((current) => ({ ...current, expiry_window: window.value }))
                    }
                  >
                    {window.label}
                  </Button>
                ))}
              </div>

              <Select
                value={filters.tld ?? "any"}
                onValueChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    tld: value === "any" ? null : value,
                  }))
                }
              >
                <SelectTrigger size="sm" className="min-w-24">
                  <SelectValue placeholder="TLD" />
                </SelectTrigger>
                <SelectContent>
                  {TLD_OPTIONS.map((tld) => (
                    <SelectItem key={tld} value={tld}>
                      {tld === "any" ? "Any TLD" : tld}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={String(filters.limit)}
                onValueChange={(value) =>
                  setFilters((current) => ({ ...current, limit: Number(value) }))
                }
              >
                <SelectTrigger size="sm" className="min-w-28">
                  <SelectValue placeholder="Results" />
                </SelectTrigger>
                <SelectContent>
                  {RESULT_LIMITS.map((limit) => (
                    <SelectItem key={limit} value={String(limit)}>
                      Top {limit}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                size="sm"
                variant={filters.include_available ? "secondary" : "outline"}
                onClick={() =>
                  setFilters((current) => ({
                    ...current,
                    include_available: !current.include_available,
                  }))
                }
              >
                Include Available
              </Button>
            </div>

            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Lifecycle
              </div>
              <div className="flex flex-wrap gap-2">
                {LIFECYCLE_FILTERS.map((item) => (
                  <Button
                    key={item.value}
                    size="sm"
                    variant={
                      filters.lifecycle_filter === item.value ? "secondary" : "outline"
                    }
                    onClick={() =>
                      setFilters((current) => ({ ...current, lifecycle_filter: item.value }))
                    }
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </Section>
      </CardHeader>

      <CardContent className="space-y-3">
        {history.length > 0 && (
          <Section
            title="Recent Searches"
            count={history.length}
            action={
              <Button size="sm" variant="ghost" onClick={() => void handleClearHistory()}>
                Clear History
              </Button>
            }
          >
            <div className="flex flex-wrap gap-2">
              {history.map((item) => (
                <Button
                  key={`${item.keyword}-${item.searched_at}`}
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void handleDiscover({
                      ...item.filters,
                      keyword: item.filters?.raw_query ?? item.keyword,
                    })
                  }
                >
                  {item.filters?.raw_query ?? item.keyword}
                  <span className="text-muted-foreground">({item.result_count})</span>
                </Button>
              ))}
            </div>
          </Section>
        )}

        {state?.no_sources_configured && (
          <div className="rounded-lg border border-dashed px-4 py-5">
            <div className="text-sm font-semibold text-foreground">
              No discovery sources configured.
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Similar mode still generates and verifies name variations, but adding a zone
              file, feed, or imported list widens the real candidate pool.
            </p>
            <Button className="mt-3" variant="outline" onClick={onConfigureSources}>
              Configure Sources
            </Button>
          </div>
        )}

        {/* Progress is the primary feedback while a run is live, so it stays
            expanded here and collapses into Search Diagnostics once done. */}
        {isRunning && (
          <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
            <div className="text-sm font-medium text-foreground">
              {state?.message ?? "Discovering..."}
            </div>
            <StageList state={state} />
          </div>
        )}

        {isComplete && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-lg font-semibold">
                  {results.length === 0
                    ? `No matching opportunities found for "${state.query?.raw_query ?? state.keyword}"`
                    : `${results.length} matching opportunit${results.length === 1 ? "y" : "ies"} found`}
                </div>
                {results.length > 0 && (
                  <div className="text-sm text-muted-foreground">
                    {state.query?.raw_query ?? state.keyword} · verified over RDAP / WHOIS
                    {state.cache_hit ? " · cached" : ""}
                  </div>
                )}
              </div>

              {results.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={sortBy} onValueChange={setSortBy}>
                    <SelectTrigger size="sm" className="min-w-40">
                      <SelectValue placeholder="Sort by" />
                    </SelectTrigger>
                    <SelectContent>
                      {SORT_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="outline" disabled={isExporting || !state.cache_key}>
                        <Download className="size-4" />
                        Export {results.length}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => void handleExport("csv")}>
                        CSV
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void handleExport("xlsx")}>
                        XLSX
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </div>

            {results.length > 0 ? (
              <ResultTable
                rows={results}
                showLifecycle
                onView={onView}
                onToggleWatchlist={onToggleWatchlist}
              />
            ) : (
              <Section title="Why no results?">
                <div className="space-y-3">
                  <div className="grid gap-1 sm:grid-cols-2">
                    {ZERO_RESULT_ROWS.map((row) => (
                      <StatRow
                        key={row.key}
                        label={row.label}
                        value={(diagnostics?.[row.key] ?? 0).toLocaleString()}
                      />
                    ))}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Every candidate above was checked against the registry. Nothing is
                    reported unless a lookup confirmed it. Try the 60-day window, a wider
                    TLD list, or Include Available.
                  </p>
                </div>
              </Section>
            )}
          </div>
        )}

        {isComplete && available.length > 0 && (
          <Section title="Available Domains" count={available.length}>
            <p className="mb-3 text-sm text-muted-foreground">
              Unregistered, so a different kind of opportunity from an expiring domain.
              These are never mixed into the results above.
            </p>
            <ResultTable
              rows={available}
              showLifecycle={false}
              onView={onView}
              onToggleWatchlist={onToggleWatchlist}
            />
          </Section>
        )}

        {isComplete && nonActionable.length > 0 && (
          <Section
            title="Non-actionable Candidates"
            count={nonActionable.length}
            summary="verified, but not an opportunity"
          >
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Domain</TableHead>
                    <TableHead>Similarity</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Verification</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {nonActionable.map((row) => (
                    <TableRow key={`${row.domain}-${row.reason_code}`}>
                      <TableCell className="font-medium">{row.domain}</TableCell>
                      <TableCell className="tabular">{row.similarity_score}%</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.detail}
                      </TableCell>
                      <TableCell className="text-xs">
                        <span
                          className={cn(
                            row.verification_status === "Verified"
                              ? "text-success"
                              : "text-muted-foreground",
                          )}
                        >
                          {row.verification_status}
                        </span>
                        <span className="text-muted-foreground">
                          {" "}
                          · {VERIFIED_LABEL[row.verification_source] ?? "—"}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Section>
        )}

        {isComplete && diagnostics && (
          <Section title="Search Diagnostics" summary={diagnosticsSummary}>
            <div className="space-y-3">
              <StageList state={state} />
              <div className="grid gap-1 sm:grid-cols-2">
                <StatRow label="Exact matches" value={diagnostics.level_exact} />
                <StatRow label="Strict matches" value={diagnostics.level_strict} />
                <StatRow label="Broader matches" value={diagnostics.level_broader} />
                <StatRow
                  label="Duration"
                  value={state.duration_ms ? `${(state.duration_ms / 1000).toFixed(1)}s` : "—"}
                />
              </div>
            </div>
          </Section>
        )}
      </CardContent>

      {showDebug && (
        <DiscoveryDebugSheet isOpen={isDebugOpen} onOpenChange={setIsDebugOpen} state={state} />
      )}
    </Card>
  )
}

export default SimilarDomainPanel
