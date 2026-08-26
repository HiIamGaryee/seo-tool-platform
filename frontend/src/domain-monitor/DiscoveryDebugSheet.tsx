import { useEffect, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

import { fetchProviderStatus, testGemini } from "./api"
import type {
  DiscoveryRejection,
  GeminiTestResult,
  ProviderStatusResponse,
  SimilarDomainState,
} from "./types"

/* Developer-only diagnostics. Rendered only when the backend reports
   DOMAIN_RADAR_DEBUG, and it displays counters and reasons — never a key. */

const STAGE_ROWS = [
  { key: "generated", label: "Generated candidates" },
  { key: "source_matches", label: "Source matches" },
  { key: "unique_candidates", label: "Unique candidates" },
  { key: "skipped_over_cap", label: "Skipped over cap" },
  { key: "verify_attempted", label: "Lookups attempted" },
  { key: "rdap_verified", label: "Verified by RDAP" },
  { key: "whois_verified", label: "Verified by WHOIS" },
  { key: "cache_reused", label: "Reused from cache" },
  { key: "lookup_failed", label: "Lookup failed" },
  { key: "unsupported_tld", label: "Unsupported TLD" },
  { key: "available_unregistered", label: "Available / unregistered" },
  { key: "no_expiry_data", label: "No expiry published" },
  { key: "safe_beyond_window", label: "Safe beyond 60 days" },
  { key: "outside_expiry_window", label: "Outside expiry window" },
  { key: "below_similarity_floor", label: "Below similarity floor" },
  { key: "filtered_by_lifecycle", label: "Filtered by lifecycle" },
  { key: "filtered_by_spam", label: "Filtered by spam risk" },
  { key: "eligible", label: "Eligible" },
  { key: "seo_analyzed", label: "SEO analyzed" },
  { key: "level_exact", label: "Exact matches" },
  { key: "level_strict", label: "Strict matches" },
  { key: "level_broader", label: "Broader matches" },
  { key: "actionable", label: "Actionable" },
  { key: "available", label: "Available" },
  { key: "non_actionable", label: "Non-actionable" },
  { key: "results", label: "Results returned" },
] as const

const PROVIDER_TONE: Record<string, string> = {
  available: "text-success",
  connected: "text-success",
  ok: "text-success",
  not_configured: "text-muted-foreground",
  disabled: "text-muted-foreground",
  unavailable: "text-destructive",
  error: "text-destructive",
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular font-medium text-foreground">{value}</span>
    </div>
  )
}

function ProviderRow({
  label,
  status,
  detail,
}: {
  label: string
  status: string
  detail: string
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="text-right">
        <div className={cn("font-medium", PROVIDER_TONE[status] ?? "text-foreground")}>
          {status}
        </div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
    </div>
  )
}

function RejectionTable({ rows }: { rows: DiscoveryRejection[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
        No per-domain decisions recorded for this run.
      </div>
    )
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Domain</TableHead>
            <TableHead>Sim</TableHead>
            <TableHead>Decision</TableHead>
            <TableHead>Reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={`${row.domain}-${row.reason}`}>
              <TableCell className="font-medium">{row.domain}</TableCell>
              <TableCell className="tabular">{row.similarity_score}</TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px]",
                    row.accepted ? "text-success" : "text-muted-foreground",
                  )}
                >
                  {row.accepted ? "Accepted" : "Rejected"}
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{row.detail}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function DiscoveryDebugSheet({
  isOpen,
  onOpenChange,
  state,
}: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  state: SimilarDomainState | null
}) {
  const [providers, setProviders] = useState<ProviderStatusResponse | null>(null)
  const [geminiTest, setGeminiTest] = useState<GeminiTestResult | null>(null)
  const [isTesting, setIsTesting] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    const controller = new AbortController()
    fetchProviderStatus(controller.signal)
      .then(setProviders)
      .catch(() => undefined)
    return () => controller.abort()
  }, [isOpen])

  const handleGeminiTest = async () => {
    setIsTesting(true)
    try {
      setGeminiTest(await testGemini())
    } catch {
      setGeminiTest(null)
    } finally {
      setIsTesting(false)
    }
  }

  const diagnostics = state?.diagnostics
  const gemini = state?.gemini ?? {}
  const duration = state?.duration_ms ? `${(state.duration_ms / 1000).toFixed(1)}s` : "—"

  return (
    <Sheet open={isOpen} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Discovery Debug</SheetTitle>
          <SheetDescription>
            Developer diagnostics for the last run. Visible only while
            DOMAIN_RADAR_DEBUG is enabled.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6 px-4 pb-8">
          {/* Proves the search token was parsed losslessly: if this shows a
              shortened second-level domain, generation is working off the
              wrong keyword. */}
          <section>
            <div className="text-sm font-semibold">Parsed Query</div>
            <StatRow label="raw_query" value={state?.query?.raw_query ?? "—"} />
            <StatRow
              label="normalized_domain"
              value={state?.query?.normalized_domain ?? "— (keyword only)"}
            />
            <StatRow
              label="second_level_domain"
              value={state?.query?.second_level_domain ?? "—"}
            />
            <StatRow label="tld" value={state?.query?.tld ?? "—"} />
            <StatRow
              label="exact_candidate"
              value={state?.query?.exact_candidate ?? "— (no TLD entered)"}
            />
            <StatRow
              label="similarity floor"
              value={`${state?.min_similarity ?? 0} · strict ≥ ${state?.strict_min_similarity ?? 0}`}
            />
          </section>

          <Separator />

          <section>
            <div className="text-sm font-semibold">Run</div>
            <StatRow label="Keyword" value={state?.keyword ?? "—"} />
            <StatRow label="Search mode" value={state?.filters?.search_mode ?? "—"} />
            <StatRow label="Expiry window" value={`${state?.filters?.expiry_window ?? "—"} days`} />
            <StatRow label="TLD filter" value={state?.filters?.tld ?? "any"} />
            <StatRow label="TLDs expanded" value={state?.tlds?.length ?? 0} />
            <StatRow label="Duration" value={duration} />
            <StatRow label="Cached" value={state?.cache_hit ? "yes" : "no"} />
          </section>

          <Separator />

          <section>
            <div className="text-sm font-semibold">Pipeline</div>
            {STAGE_ROWS.map((row) => (
              <StatRow
                key={row.key}
                label={row.label}
                value={diagnostics ? (diagnostics[row.key] ?? 0) : 0}
              />
            ))}
          </section>

          <Separator />

          <section>
            <div className="text-sm font-semibold">Ranking weights</div>
            <StatRow
              label="Similarity"
              value={`${Math.round((state?.weights?.similarity ?? 0) * 100)}%`}
            />
            <StatRow
              label="Lifecycle urgency"
              value={`${Math.round((state?.weights?.lifecycle ?? 0) * 100)}%`}
            />
            <StatRow
              label="SEO opportunity"
              value={`${Math.round((state?.weights?.seo ?? 0) * 100)}%`}
            />
          </section>

          <Separator />

          <section className="space-y-2">
            <div className="text-sm font-semibold">Sources</div>
            {state?.source_details?.length ? (
              state.source_details.map((detail) => (
                <div
                  key={detail.name}
                  className="rounded-md border border-border bg-muted/20 px-3 py-2 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{detail.label}</span>
                    <span
                      className={cn(
                        "text-xs font-medium",
                        detail.status === "error"
                          ? "text-destructive"
                          : detail.status === "success"
                            ? "text-success"
                            : "text-muted-foreground",
                      )}
                    >
                      {detail.status}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {detail.searched.toLocaleString()} scanned ·{" "}
                    {detail.matched.toLocaleString()} matched · {detail.duration_ms}ms
                  </div>
                  {detail.error && (
                    <div className="mt-1 text-xs text-destructive">{detail.error}</div>
                  )}
                </div>
              ))
            ) : (
              <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
                No sources reported for this run.
              </div>
            )}
          </section>

          <Separator />

          <section>
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold">Gemini extraction</div>
              <Button size="sm" variant="outline" onClick={handleGeminiTest} disabled={isTesting}>
                {isTesting ? "Testing..." : "Test"}
              </Button>
            </div>
            <StatRow label="Configured" value={gemini.configured ? "true" : "false"} />
            <StatRow label="Provider" value={gemini.provider ?? "—"} />
            <StatRow label="Model" value={gemini.model ?? "—"} />
            <StatRow label="Calls this run" value={gemini.calls ?? 0} />
            <StatRow label="Success" value={gemini.success ?? 0} />
            <StatRow label="Failures" value={gemini.failures ?? 0} />
            <StatRow label="Domains extracted" value={gemini.domains ?? 0} />
            {gemini.reason && <StatRow label="Reason" value={gemini.reason} />}
            {gemini.last_error && <StatRow label="Last error" value={gemini.last_error} />}
            {geminiTest && (
              <div className="mt-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
                <div className="font-medium">Test: {geminiTest.status}</div>
                <div className="text-muted-foreground">
                  {geminiTest.model ?? "no model"} ·{" "}
                  {geminiTest.latency_ms === null ? "—" : `${geminiTest.latency_ms}ms`}
                </div>
                {geminiTest.message && (
                  <div className="mt-1 text-destructive">{geminiTest.message}</div>
                )}
              </div>
            )}
          </section>

          <Separator />

          <section>
            <div className="text-sm font-semibold">Providers</div>
            {providers ? (
              <>
                <ProviderRow
                  label="RDAP"
                  status={providers.rdap.status}
                  detail={providers.rdap.detail}
                />
                <ProviderRow
                  label="WHOIS"
                  status={providers.whois.status}
                  detail={providers.whois.detail}
                />
                <ProviderRow
                  label="Crawl4AI"
                  status={providers.crawl4ai.status}
                  detail={providers.crawl4ai.detail}
                />
                <ProviderRow
                  label="Gemini"
                  status={providers.gemini.status}
                  detail={providers.gemini.detail}
                />
                <StatRow label="Similarity backend" value={providers.fuzzy_backend} />
                <StatRow label="Max generated" value={providers.limits.max_generated} />
                <StatRow label="Max verified" value={providers.limits.max_verified} />
              </>
            ) : (
              <div className="text-sm text-muted-foreground">Loading provider status...</div>
            )}
          </section>

          <Separator />

          <section className="space-y-2">
            <div className="text-sm font-semibold">Per-domain decisions</div>
            <RejectionTable rows={state?.rejections ?? []} />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}

export default DiscoveryDebugSheet
