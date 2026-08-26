import { useEffect, useState } from "react"
import { CircleAlert, CircleCheck } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
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
  errorMessage,
  fetchProviderStatus,
  refreshCrawlSources,
  saveCrawlSource,
  testCrawlSource,
  testGemini,
} from "./api"
import { formatDate } from "./types"
import type {
  CrawlSourceForm,
  DataSource,
  DiscoverySource,
  GeminiTestResult,
  ProviderStatusResponse,
} from "./types"

const STATUS_TONE: Record<string, string> = {
  Active: "text-success",
  Configured: "text-success",
  "Not Configured": "text-muted-foreground",
  Disabled: "text-muted-foreground",
  Failed: "text-destructive",
}

const DEFAULT_FORM: CrawlSourceForm = {
  name: "",
  url: "",
  enabled: true,
  max_pages: 10,
  css_selector: "",
  next_page_selector: "",
  use_gemini: false,
}

function DataSourcesDialog({
  isOpen,
  onOpenChange,
  sources,
  discovery,
  refreshed,
  onImport,
  onReload,
}: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  sources: DataSource[]
  discovery: DiscoverySource[]
  refreshed: { rdap: string | null; backlinks: string | null; history: string | null } | null
  onImport: () => void
  onReload: () => void
}) {
  const [isConfigureOpen, setIsConfigureOpen] = useState(false)
  const [form, setForm] = useState<CrawlSourceForm>(DEFAULT_FORM)
  const [testResult, setTestResult] = useState<{
    status: string
    pages: number
    candidate_domains: number
    sample: string[]
    error: string | null
  } | null>(null)
  const [isTesting, setIsTesting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [providers, setProviders] = useState<ProviderStatusResponse | null>(null)
  const [geminiTest, setGeminiTest] = useState<GeminiTestResult | null>(null)
  const [isGeminiTesting, setIsGeminiTesting] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    const controller = new AbortController()
    fetchProviderStatus(controller.signal)
      .then(setProviders)
      .catch(() => undefined)
    return () => controller.abort()
  }, [isOpen])

  const stamps = [
    { label: "RDAP checked", value: refreshed?.rdap ?? null },
    { label: "Backlink refresh", value: refreshed?.backlinks ?? null },
    { label: "Archive refresh", value: refreshed?.history ?? null },
  ]

  const crawlSources = discovery.filter((source) => source.kind === "crawl4ai")
  const crawlCandidateTotal = crawlSources.reduce(
    (total, source) => total + (source.candidates ?? 0),
    0,
  )
  const crawlLastSync = crawlSources
    .map((source) => source.last_sync)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1)
  const crawlGeminiEnabled = crawlSources.some((source) => source.gemini_fallback)

  const updateForm = <K extends keyof CrawlSourceForm>(key: K, value: CrawlSourceForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const handleTest = async () => {
    setIsTesting(true)
    setTestResult(null)
    try {
      const result = await testCrawlSource(form)
      setTestResult(result)
      toast.success("Crawl successful", {
        description: `${result.candidate_domains.toLocaleString()} candidate domains found.`,
      })
    } catch (caught) {
      toast.error("Crawl source test failed", { description: errorMessage(caught) })
    } finally {
      setIsTesting(false)
    }
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      await saveCrawlSource(form)
      toast.success("Crawl source saved", { description: form.name || form.url })
      setForm(DEFAULT_FORM)
      setTestResult(null)
      setIsConfigureOpen(false)
      onReload()
    } catch (caught) {
      toast.error("Could not save crawl source", { description: errorMessage(caught) })
    } finally {
      setIsSaving(false)
    }
  }

  /* Connectivity is probed on the backend so the credential stays there. */
  const handleGeminiTest = async () => {
    setIsGeminiTesting(true)
    try {
      const result = await testGemini()
      setGeminiTest(result)
      if (result.status === "ok") {
        toast.success("Gemini connected", {
          description: `${result.model} · ${result.latency_ms}ms`,
        })
      } else {
        toast.warning("Gemini unavailable", {
          description: result.message ?? result.error ?? "Not configured",
        })
      }
    } catch (caught) {
      toast.error("Gemini test failed", { description: errorMessage(caught) })
    } finally {
      setIsGeminiTesting(false)
    }
  }

  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      await refreshCrawlSources()
      toast.success("Crawl sources refreshed")
      onReload()
    } catch (caught) {
      toast.error("Refresh failed", { description: errorMessage(caught) })
    } finally {
      setIsRefreshing(false)
    }
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Data Sources</DialogTitle>
            <DialogDescription>
              Candidate discovery and enrichment sources, each on its own schedule.
            </DialogDescription>
          </DialogHeader>

          {providers && (
            <div className="rounded-lg border bg-muted/20 p-3 text-sm">
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Verification Providers
              </h3>
              <div className="grid gap-2 md:grid-cols-4">
                {[
                  { label: "RDAP", value: providers.rdap },
                  { label: "WHOIS", value: providers.whois },
                  { label: "Crawl4AI", value: providers.crawl4ai },
                  { label: "Gemini", value: providers.gemini },
                ].map((row) => (
                  <div key={row.label}>
                    <div className="font-medium text-foreground">{row.label}</div>
                    <div
                      className={cn(
                        "text-xs",
                        STATUS_TONE[row.value.status] ??
                          (row.value.status === "available" || row.value.status === "connected"
                            ? "text-success"
                            : "text-muted-foreground"),
                      )}
                    >
                      {row.value.status}
                    </div>
                    <div className="text-xs text-muted-foreground">{row.value.detail}</div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                <div>
                  <div className="font-medium text-foreground">Gemini Extraction</div>
                  <div className="text-xs text-muted-foreground">
                    {geminiTest
                      ? `${geminiTest.status}${
                          geminiTest.latency_ms === null ? "" : ` · ${geminiTest.latency_ms}ms`
                        }${geminiTest.message ? ` · ${geminiTest.message}` : ""}`
                      : providers.gemini.model
                        ? providers.gemini.model
                        : "Optional Crawl4AI extraction fallback"}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleGeminiTest}
                  disabled={isGeminiTesting}
                >
                  {isGeminiTesting ? "Testing..." : "Test"}
                </Button>
              </div>
            </div>
          )}

          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Candidate Discovery
            </h3>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Source</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Candidates</TableHead>
                    <TableHead>Last Sync</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {discovery.map((source) => (
                    <TableRow key={`${source.kind}-${source.name}`}>
                      <TableCell>
                        <div className="font-medium">{source.label}</div>
                        <div className="max-w-72 truncate text-xs text-muted-foreground">
                          {source.detail}
                        </div>
                      </TableCell>
                      <TableCell
                        className={cn("text-xs", STATUS_TONE[source.status] ?? "text-muted-foreground")}
                      >
                        {source.status}
                      </TableCell>
                      <TableCell className="tabular text-right">
                        {source.candidates === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          source.candidates.toLocaleString()
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {source.last_sync ? formatDate(source.last_sync) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Configure with <code>DOMAIN_SOURCES</code>, <code>ZONE_FILE_DIRECTORY</code>,{" "}
                <code>DOMAIN_FEED_URL</code>, and Crawl4AI source settings.
              </p>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={handleRefresh} disabled={isRefreshing}>
                  {isRefreshing ? "Refreshing..." : "Refresh"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setIsConfigureOpen(true)}>
                  Configure
                </Button>
                <Button size="sm" variant="outline" onClick={onImport}>
                  Import
                </Button>
              </div>
            </div>
            {crawlSources.length > 0 ? (
              <div className="mt-3 space-y-3 rounded-lg border bg-muted/20 p-3 text-sm">
                <div>
                  <div className="font-medium text-foreground">Crawl4AI</div>
                  <div className="mt-1 grid gap-2 text-muted-foreground md:grid-cols-4">
                    <div>Status: Active</div>
                    <div>Sources: {crawlSources.length} configured</div>
                    <div>Domains Found: {crawlCandidateTotal.toLocaleString()}</div>
                    <div>Gemini Fallback: {crawlGeminiEnabled ? "Enabled" : "Disabled"}</div>
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    Last Crawl: {crawlLastSync ? formatDate(crawlLastSync) : "Never"}
                  </div>
                </div>
                <div className="space-y-2">
                  {crawlSources.map((source) => (
                    <div
                      key={source.id ?? source.name}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background/40 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-foreground">{source.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {source.source_url ?? source.detail}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Max Pages: {source.max_pages ?? "—"} · Gemini:{" "}
                          {source.gemini_fallback ? "Enabled" : "Disabled"}
                        </div>
                      </div>
                      <div className="text-right text-xs text-muted-foreground">
                        <div>{source.candidates?.toLocaleString() ?? "—"} candidates</div>
                        <div>{source.last_sync ? formatDate(source.last_sync) : "Never crawled"}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <Separator />

          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Verification & Enrichment
          </h3>
          <ul className="space-y-2.5">
            {sources.map((source) => (
              <li key={source.key} className="flex items-start gap-2.5">
                {source.available ? (
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
                ) : (
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-caution" />
                )}
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2 text-sm">
                    <span className="font-medium">{source.label}</span>
                    <span
                      className={cn(
                        "text-xs",
                        source.available ? "text-success" : "text-caution",
                      )}
                    >
                      {source.status}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{source.detail}</p>
                </div>
              </li>
            ))}
          </ul>

          <Separator />

          <dl className="space-y-1.5 text-sm">
            {stamps.map((stamp) => (
              <div key={stamp.label} className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">{stamp.label}</dt>
                <dd>{stamp.value ? formatDate(stamp.value) : <span className="text-muted-foreground">Never</span>}</dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>

      <Dialog open={isConfigureOpen} onOpenChange={setIsConfigureOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Crawl Source</DialogTitle>
            <DialogDescription>
              Configure a publicly accessible source for Crawl4AI domain discovery.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">Source Name</div>
              <Input
                id="crawl-source-name"
                value={form.name}
                onChange={(event) => updateForm("name", event.target.value)}
                placeholder="Expired Feed A"
              />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">Source URL</div>
              <Input
                id="crawl-source-url"
                value={form.url}
                onChange={(event) => updateForm("url", event.target.value)}
                placeholder="https://example.com/dropping-domains"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="text-sm font-medium text-foreground">Max Pages</div>
                <Input
                  id="crawl-source-max-pages"
                  type="number"
                  min={1}
                  max={50}
                  value={form.max_pages}
                  onChange={(event) => updateForm("max_pages", Number(event.target.value) || 1)}
                />
              </div>
              <div className="space-y-2">
                <div className="text-sm font-medium text-foreground">CSS Selector</div>
                <Input
                  id="crawl-source-selector"
                  value={form.css_selector}
                  onChange={(event) => updateForm("css_selector", event.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">Next-Page Selector</div>
              <Input
                id="crawl-source-next-page"
                value={form.next_page_selector}
                onChange={(event) => updateForm("next_page_selector", event.target.value)}
                placeholder="Optional"
              />
            </div>

            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={form.enabled}
                  onCheckedChange={(checked) => updateForm("enabled", checked === true)}
                />
                <span>Enabled</span>
              </label>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={form.use_gemini}
                  onCheckedChange={(checked) => updateForm("use_gemini", checked === true)}
                />
                <span>Gemini fallback</span>
              </label>
            </div>

            {testResult ? (
              <div className="rounded-lg border bg-muted/20 p-3 text-sm">
                <div className="font-medium text-foreground">
                  {testResult.status === "active" ? "Crawl successful" : testResult.status}
                </div>
                <div className="mt-1 text-muted-foreground">
                  Pages: {testResult.pages} · Candidate domains: {testResult.candidate_domains.toLocaleString()}
                </div>
                {testResult.error ? (
                  <div className="mt-2 text-destructive">{testResult.error}</div>
                ) : null}
                {testResult.sample.length > 0 ? (
                  <div className="mt-2 text-muted-foreground">
                    Sample: {testResult.sample.join(", ")}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setIsConfigureOpen(false)}>
                Cancel
              </Button>
              <Button variant="outline" onClick={() => void handleTest()} disabled={isTesting}>
                {isTesting ? "Testing..." : "Test Source"}
              </Button>
              <Button onClick={() => void handleSave()} disabled={isSaving}>
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default DataSourcesDialog
