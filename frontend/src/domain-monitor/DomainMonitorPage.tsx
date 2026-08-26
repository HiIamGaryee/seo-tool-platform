import { useCallback, useEffect, useState } from "react"
import {
  Columns3,
  Database,
  Download,
  ScanSearch,
  SlidersHorizontal,
  Sparkles,
  Upload,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

import CompareDialog from "./CompareDialog"
import DataSourcesDialog from "./DataSourcesDialog"
import DomainDetailSheet from "./DomainDetailSheet"
import DomainFilters from "./DomainFilters"
import DomainImportDialog from "./DomainImportDialog"
import DomainScanDialog from "./DomainScanDialog"
import DomainStats from "./DomainStats"
import DomainTable from "./DomainTable"
import SimilarDomainPanel from "./SimilarDomainPanel"
import NicheSettingsDialog from "./NicheSettingsDialog"
import TopOpportunities from "./TopOpportunities"
import {
  compareDomains,
  errorMessage,
  exportDomains,
  fetchDomain,
  fetchDiscoverySources,
  fetchDomains,
  fetchEnrichmentState,
  fetchOpportunities,
  fetchScanState,
  fetchStats,
  saveTargetNiches,
  setWatchlist,
  startEnrichment,
  startScan,
  type ScanOptions,
} from "./api"
import {
  CATEGORY_TABS,
  DEFAULT_QUERY,
  hasActiveFilters,
  type DomainDetail,
  type DomainListResponse,
  type DomainQuery,
  type DomainRecord,
  type DiscoverySourcesResponse,
  type DomainStatsResponse,
  type EnrichmentState,
  type ScanState,
} from "./types"

const SEARCH_DEBOUNCE_MS = 400
const POLL_MS = 1500
const MAX_COMPARE = 3

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

function DomainMonitorPage() {
  const [query, setQuery] = useState<DomainQuery>(DEFAULT_QUERY)
  const [searchInput, setSearchInput] = useState("")
  const [data, setData] = useState<DomainListResponse | null>(null)
  const [stats, setStats] = useState<DomainStatsResponse | null>(null)
  const [opportunities, setOpportunities] = useState<DomainRecord[] | null>(null)
  const [scan, setScan] = useState<ScanState | null>(null)
  const [discovery, setDiscovery] = useState<DiscoverySourcesResponse | null>(null)
  const [enrichment, setEnrichment] = useState<EnrichmentState | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<DomainDetail | null>(null)
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [compareItems, setCompareItems] = useState<DomainRecord[] | null>(null)
  const [isImportOpen, setIsImportOpen] = useState(false)
  const [isScanOpen, setIsScanOpen] = useState(false)
  const [isSourcesOpen, setIsSourcesOpen] = useState(false)
  const [isNichesOpen, setIsNichesOpen] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  /* Debounce the search box so typing does not fire a request per keystroke. */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery((current) =>
        current.search === searchInput
          ? current
          : { ...current, search: searchInput, page: 1 },
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    const controller = new AbortController()
    setIsLoading(true)

    fetchDomains(query, controller.signal)
      .then((list) => {
        setData(list)
        setError(null)
      })
      .catch((caught) => {
        if (controller.signal.aborted) return
        // No silent fallback to placeholder rows: the table surfaces the failure.
        setError(errorMessage(caught))
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false)
      })

    return () => controller.abort()
  }, [query, reloadToken])

  /* Global summaries do not depend on the filters, so they refetch separately. */
  useEffect(() => {
    const controller = new AbortController()

    fetchStats(controller.signal)
      .then((summary) => {
        setStats(summary)
        setScan(summary.scan)
        setEnrichment(summary.enrichment)
      })
      .catch(() => {
        if (!controller.signal.aborted) setStats(null)
      })

    fetchOpportunities(6, controller.signal)
      .then(setOpportunities)
      .catch(() => {
        if (!controller.signal.aborted) setOpportunities(null)
      })

    fetchDiscoverySources(controller.signal)
      .then(setDiscovery)
      .catch(() => {
        if (!controller.signal.aborted) setDiscovery(null)
      })

    return () => controller.abort()
  }, [reloadToken])

  /* Poll only while a lifecycle scan is live. */
  useEffect(() => {
    if (scan?.status !== "running") return

    const interval = window.setInterval(async () => {
      try {
        const state = await fetchScanState()
        setScan(state)
        if (state.status !== "running") {
          window.clearInterval(interval)
          if (state.error) {
            toast.error("Scan failed", { description: state.error })
          } else {
            toast.success("Scan completed", {
              description:
                `${state.unique.toLocaleString()} unique candidates from ` +
                `${state.discovered.toLocaleString()} discovered; ` +
                `${state.checked.toLocaleString()} verified via RDAP.`,
            })
          }
          reload()
        }
      } catch (caught) {
        window.clearInterval(interval)
        toast.error("Lost track of the scan", { description: errorMessage(caught) })
      }
    }, POLL_MS)

    return () => window.clearInterval(interval)
  }, [scan?.status, reload])

  /* Enrichment runs on its own schedule, so it gets its own poll. */
  useEffect(() => {
    if (enrichment?.status !== "running") return

    const interval = window.setInterval(async () => {
      try {
        const state = await fetchEnrichmentState()
        setEnrichment(state)
        if (state.status !== "running") {
          window.clearInterval(interval)
          if (state.error) {
            toast.error("Enrichment failed", { description: state.error })
          } else {
            toast.success("SEO enrichment complete", {
              description: `${state.scored} scored, ${state.unscored} lacked enough data, ${state.high_opportunity} high opportunity.`,
            })
          }
          reload()
        }
      } catch (caught) {
        window.clearInterval(interval)
        toast.error("Lost track of enrichment", { description: errorMessage(caught) })
      }
    }, POLL_MS)

    return () => window.clearInterval(interval)
  }, [enrichment?.status, reload])

  const handleQueryChange = (patch: Partial<DomainQuery>) => {
    setQuery((current) => ({ ...current, ...patch }))
  }

  const handleReset = () => {
    setSearchInput("")
    setQuery(DEFAULT_QUERY)
  }

  const handleSort = (key: string) => {
    if (!key) return
    setQuery((current) => ({
      ...current,
      sort: key,
      order: current.sort === key && current.order === "desc" ? "asc" : "desc",
      page: 1,
    }))
  }

  const openDetail = async (record: DomainRecord) => {
    setDetail({
      ...record,
      snapshots: [],
      status_history: [],
      metric_history: [],
      discovery_sources: [],
    })
    setIsLoadingDetail(true)
    try {
      setDetail(await fetchDomain(record.domain))
    } catch (caught) {
      toast.error("Could not load domain detail", { description: errorMessage(caught) })
    } finally {
      setIsLoadingDetail(false)
    }
  }

  const handleStartScan = async (options: ScanOptions) => {
    try {
      const response = await startScan(options)
      setScan(response)
      if (!response.started) {
        toast.warning(response.reason ?? "A scan is already running.")
      } else if (discovery && !discovery.any_configured) {
        toast.warning("No domain sources configured", {
          description: "Import a TXT/CSV list or set DOMAIN_SOURCES to discover candidates.",
        })
      } else {
        toast.info("Scan started", { description: "Discovering candidate domains." })
      }
    } catch (caught) {
      toast.error("Could not start scan", { description: errorMessage(caught) })
    }
  }

  const handleEnrich = async () => {
    try {
      const response = await startEnrichment({ force: true })
      setEnrichment(response)
      if (response.started) {
        toast.info("SEO enrichment started", {
          description:
            response.provider === "none"
              ? "Archive history and scoring only — no backlink provider configured."
              : `Using ${response.provider} for backlink data.`,
        })
      } else {
        toast.warning(response.reason ?? "Enrichment already running.")
      }
    } catch (caught) {
      toast.error("Could not start enrichment", { description: errorMessage(caught) })
    }
  }

  const handleRecheck = async (record: DomainRecord) => {
    try {
      const response = await startScan({ domains: [record.domain], useSources: false })
      setScan(response)
      toast[response.started ? "info" : "warning"](
        response.started ? `Rechecking ${record.domain}` : response.reason ?? "A scan is already running.",
      )
    } catch (caught) {
      toast.error("Recheck failed", { description: errorMessage(caught) })
    }
  }

  const handleCopy = async (record: DomainRecord) => {
    try {
      await navigator.clipboard.writeText(record.domain)
      toast.success("Copied", { description: record.domain })
    } catch (caught) {
      toast.error("Could not copy", { description: errorMessage(caught) })
    }
  }

  const handleExport = async (
    scopedQuery: DomainQuery,
    fmt: "csv" | "xlsx",
    filename: string,
  ) => {
    setIsExporting(true)
    try {
      downloadBlob(await exportDomains(scopedQuery, fmt), filename)
      toast.success("Export ready", { description: filename })
    } catch (caught) {
      toast.error("Export failed", { description: errorMessage(caught) })
    } finally {
      setIsExporting(false)
    }
  }

  const handleWatchlist = async (domain: string, watchlisted: boolean, notes?: string) => {
    try {
      const updated = await setWatchlist(domain, watchlisted, notes)
      setDetail((current) =>
        current && current.domain === domain ? { ...current, ...updated } : current,
      )
      toast.success(watchlisted ? "Added to watchlist" : "Removed from watchlist", {
        description: domain,
      })
      reload()
    } catch (caught) {
      toast.error("Watchlist update failed", { description: errorMessage(caught) })
    }
  }

  const handleSaveNiches = async (niches: string[]) => {
    try {
      const result = await saveTargetNiches(niches)
      toast.success("Target niches saved", {
        description:
          result.target_niches.length > 0
            ? `${result.target_niches.join(", ")} — re-run enrichment to rescore.`
            : "No niches set; topical relevance will be excluded from scoring.",
      })
      reload()
    } catch (caught) {
      toast.error("Could not save niches", { description: errorMessage(caught) })
    }
  }

  const toggleSelected = (domain: string) => {
    setSelected((current) => {
      if (current.includes(domain)) return current.filter((item) => item !== domain)
      if (current.length >= MAX_COMPARE) {
        toast.warning(`Compare up to ${MAX_COMPARE} domains at a time.`)
        return current
      }
      return [...current, domain]
    })
  }

  const handleCompare = async () => {
    try {
      const result = await compareDomains(selected)
      setCompareItems(result.items)
      if (result.missing.length > 0) {
        toast.warning(`Not monitored: ${result.missing.join(", ")}`)
      }
    } catch (caught) {
      toast.error("Compare failed", { description: errorMessage(caught) })
    }
  }

  const isScanning = scan?.status === "running"
  const isEnriching = enrichment?.status === "running"

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            SEO Domain Radar
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Discover and evaluate expired and expiring domains for SEO opportunities.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setIsSourcesOpen(true)}>
            <Database className="size-4" />
            Sources
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setIsNichesOpen(true)}>
            <SlidersHorizontal className="size-4" />
            Niches
            {stats && stats.target_niches.length > 0 && (
              <span className="text-muted-foreground">({stats.target_niches.length})</span>
            )}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setIsImportOpen(true)}>
            <Upload className="size-4" />
            Import
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={isExporting || !data || data.total === 0}
              >
                <Download className="size-4" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => handleExport(query, "csv", "seo-domain-radar.csv")}
              >
                Download CSV
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => handleExport(query, "xlsx", "seo-domain-radar.xlsx")}
              >
                Download XLSX
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button variant="outline" size="sm" onClick={handleEnrich} disabled={isEnriching}>
            <Sparkles className="size-4" />
            {isEnriching
              ? `Enriching ${enrichment?.checked ?? 0}/${enrichment?.total ?? 0}`
              : "Refresh SEO Data"}
          </Button>
          <Button size="sm" onClick={() => setIsScanOpen(true)}>
            <ScanSearch className="size-4" />
            {isScanning ? "Scanning..." : "Run Scan"}
          </Button>
        </div>
      </div>

      <SimilarDomainPanel
        onView={openDetail}
        onToggleWatchlist={(record) =>
          handleWatchlist(record.domain, !record.watchlisted)
        }
        onConfigureSources={() => setIsSourcesOpen(true)}
      />

      <DomainStats stats={stats} />

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Top SEO Opportunities</h2>
          {stats && stats.scored > 0 && (
            <span className="text-xs text-muted-foreground">
              {stats.scored.toLocaleString()} of {stats.total.toLocaleString()} domains scored
            </span>
          )}
        </div>
        <TopOpportunities
          items={opportunities}
          isLoading={isLoading && !opportunities}
          onView={openDetail}
        />
      </div>

      <div className="space-y-3">
        <DomainFilters
          query={query}
          stats={stats}
          searchInput={searchInput}
          onSearchInput={setSearchInput}
          onChange={handleQueryChange}
          onReset={handleReset}
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs
            value={query.category || "all"}
            onValueChange={(value) =>
              handleQueryChange({ category: value === "all" ? "" : value, page: 1 })
            }
          >
            <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-md bg-transparent p-0">
              {CATEGORY_TABS.map((tab) => (
                <TabsTrigger
                  key={tab.label}
                  value={tab.category || "all"}
                  className="rounded-md border border-transparent px-2.5 py-1.5 text-xs data-[state=active]:border-border data-[state=active]:bg-muted data-[state=active]:shadow-none"
                >
                  {tab.label}
                  {stats && tab.category && (
                    <span className="tabular ml-1.5 text-muted-foreground">
                      {(stats.by_category[tab.category] ?? 0).toLocaleString()}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {selected.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {selected.length} selected
              </span>
              <Button size="sm" variant="outline" onClick={handleCompare}>
                <Columns3 className="size-3.5" />
                Compare
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                Clear
              </Button>
            </div>
          )}
        </div>
      </div>

      <DomainTable
        data={data}
        query={query}
        isLoading={isLoading}
        error={error}
        hasFilters={hasActiveFilters(query)}
        noSourcesConfigured={Boolean(discovery && !discovery.any_configured)}
        selected={selected}
        onToggleSelected={toggleSelected}
        onSort={handleSort}
        onPage={(page) => handleQueryChange({ page })}
        onRetry={reload}
        onView={openDetail}
        onCopy={handleCopy}
        onRecheck={handleRecheck}
        onExportRow={(record) =>
          handleExport(
            { ...DEFAULT_QUERY, search: record.domain },
            "csv",
            `${record.domain}.csv`,
          )
        }
        onToggleWatchlist={(record) =>
          handleWatchlist(record.domain, !record.watchlisted)
        }
        onImport={() => setIsImportOpen(true)}
        onConfigureSources={() => setIsSourcesOpen(true)}
      />

      <p className="text-xs text-muted-foreground">
        SEO and spam scores are internal rule-based measures computed from configured
        thresholds and real source data — not Google metrics, and not a prediction of
        resale value. A domain that is expired, in redemption or pending delete is not
        necessarily available to register.
      </p>

      <DomainDetailSheet
        record={detail}
        isLoadingDetail={isLoadingDetail}
        onOpenChange={(open) => !open && setDetail(null)}
        onSaveWatchlist={(domain, watchlisted, notes) =>
          handleWatchlist(domain, watchlisted, notes)
        }
      />

      <DomainImportDialog
        isOpen={isImportOpen}
        onOpenChange={setIsImportOpen}
        onImported={(result) => {
          toast.success("Import successful", {
            description:
              `${result.imported} imported, ${result.duplicates} duplicates, ` +
              `${result.invalid} invalid. Run a scan to verify them.`,
          })
          reload()
        }}
      />

      <DomainScanDialog
        isOpen={isScanOpen}
        onOpenChange={setIsScanOpen}
        scan={scan}
        sources={discovery}
        onStart={handleStartScan}
      />

      <DataSourcesDialog
        isOpen={isSourcesOpen}
        onOpenChange={setIsSourcesOpen}
        sources={stats?.data_sources ?? []}
        discovery={discovery?.sources ?? []}
        refreshed={stats?.refreshed ?? null}
        onImport={() => {
          setIsSourcesOpen(false)
          setIsImportOpen(true)
        }}
        onReload={reload}
      />

      <NicheSettingsDialog
        isOpen={isNichesOpen}
        onOpenChange={setIsNichesOpen}
        availableTopics={stats?.available_topics ?? []}
        selected={stats?.target_niches ?? []}
        onSave={handleSaveNiches}
      />

      <CompareDialog
        isOpen={Boolean(compareItems)}
        onOpenChange={(open) => !open && setCompareItems(null)}
        items={compareItems ?? []}
      />
    </div>
  )
}

export default DomainMonitorPage
