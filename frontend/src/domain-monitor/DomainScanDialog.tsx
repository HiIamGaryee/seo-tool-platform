import { useEffect, useState } from "react"
import { CircleAlert, Loader2, ScanSearch } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

import type { ScanOptions } from "./api"
import type { DiscoverySourcesResponse, ScanState } from "./types"

/* Only counters the backend actually reports. Nothing is estimated and no
   timer ever advances progress on its own. */
const PROGRESS_COUNTERS = [
  { key: "expired", label: "Expired", tone: "text-severe" },
  { key: "expiring_30", label: "≤30 days", tone: "text-caution" },
  { key: "expiring_31_60", label: "31–60 days", tone: "text-info" },
  { key: "redemption", label: "Redemption", tone: "text-critical" },
  { key: "pending_delete", label: "Pending delete", tone: "text-destructive" },
  { key: "failed", label: "Lookup failed", tone: "text-muted-foreground" },
] as const

function DomainScanDialog({
  isOpen,
  onOpenChange,
  scan,
  sources,
  onStart,
}: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  scan: ScanState | null
  sources: DiscoverySourcesResponse | null
  onStart: (options: ScanOptions) => Promise<void>
}) {
  const [selectedKinds, setSelectedKinds] = useState<string[]>([])
  const [force, setForce] = useState(false)
  const [enrich, setEnrich] = useState(true)
  const [limit, setLimit] = useState("")
  const [isStarting, setIsStarting] = useState(false)

  const selectable = (sources?.sources ?? []).filter(
    (source) => source.enabled && source.configured,
  )

  /* Default to every usable source; nothing unconfigured is ever pre-checked. */
  useEffect(() => {
    if (isOpen) {
      setSelectedKinds(selectable.map((source) => source.kind))
      setLimit(sources ? String(sources.max_candidates) : "")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, sources])

  const isScanning = scan?.status === "running"
  const progress =
    scan && scan.total > 0 ? Math.min(100, (scan.checked / scan.total) * 100) : 0

  const toggleKind = (kind: string) => {
    setSelectedKinds((current) =>
      current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind],
    )
  }

  const handleStart = async () => {
    setIsStarting(true)
    try {
      const parsed = Number.parseInt(limit, 10)
      await onStart({
        sources: selectedKinds,
        force,
        enrich,
        limit: Number.isFinite(parsed) && parsed > 0 ? parsed : null,
      })
    } finally {
      setIsStarting(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Run Domain Scan</DialogTitle>
          <DialogDescription>
            Candidates are discovered, deduplicated, then verified against RDAP.
          </DialogDescription>
        </DialogHeader>

        {isScanning ? (
          <div className="space-y-4">
            <div>
              <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Discovery
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Discovered</dt>
                  <dd className="tabular">{scan.discovered.toLocaleString()}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Unique</dt>
                  <dd className="tabular font-medium">{scan.unique.toLocaleString()}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Duplicates</dt>
                  <dd className="tabular">{scan.duplicates.toLocaleString()}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Rejected</dt>
                  <dd className="tabular">{scan.invalid.toLocaleString()}</dd>
                </div>
              </dl>
              {scan.truncated && (
                <p className="mt-1.5 text-xs text-caution">
                  Candidate cap reached — raise DOMAIN_SOURCE_MAX_CANDIDATES to scan more.
                </p>
              )}
            </div>

            <Separator />

            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <Loader2 className="size-3.5 animate-spin" />
                  RDAP verification
                </span>
                <span className="tabular text-muted-foreground">
                  {scan.checked.toLocaleString()} / {scan.total.toLocaleString()}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {PROGRESS_COUNTERS.map((counter) => (
                <div key={counter.key} className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">{counter.label}</dt>
                  <dd className={cn("tabular font-medium", counter.tone)}>
                    {scan[counter.key].toLocaleString()}
                  </dd>
                </div>
              ))}
            </dl>

            {scan.skipped_cached > 0 && (
              <p className="text-xs text-muted-foreground">
                {scan.skipped_cached.toLocaleString()} skipped — checked recently enough
                to reuse the cached result.
              </p>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Run in background
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2.5">
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Sources
              </div>

              {selectable.length === 0 ? (
                <Alert>
                  <CircleAlert />
                  <AlertTitle>No domain sources configured</AlertTitle>
                  <AlertDescription>
                    Import a TXT/CSV list, or set <code>DOMAIN_SOURCES</code> with a
                    zone directory or feed URL.
                  </AlertDescription>
                </Alert>
              ) : (
                (sources?.sources ?? []).map((source) => {
                  const usable = source.enabled && source.configured
                  return (
                    <label
                      key={source.kind}
                      className={cn(
                        "flex items-start gap-2.5 text-sm",
                        !usable && "opacity-60",
                      )}
                    >
                      <Checkbox
                        checked={selectedKinds.includes(source.kind)}
                        onCheckedChange={() => toggleKind(source.kind)}
                        disabled={!usable}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-baseline gap-1.5">
                          {source.label}
                          <span
                            className={cn(
                              "text-xs",
                              usable ? "text-success" : "text-muted-foreground",
                            )}
                          >
                            {source.status}
                          </span>
                          {source.candidates !== null && (
                            <span className="tabular text-xs text-muted-foreground">
                              {source.candidates.toLocaleString()} stored
                            </span>
                          )}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {source.detail}
                        </span>
                      </span>
                    </label>
                  )
                })
              )}
            </div>

            <Separator />

            <div className="space-y-1.5">
              <label htmlFor="scan-limit" className="text-sm font-medium">
                Candidate limit
              </label>
              <Input
                id="scan-limit"
                type="number"
                min={1}
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
                placeholder="No limit"
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Guards against pulling a whole zone file during testing. RDAP runs{" "}
                {sources?.rdap_concurrency ?? 10} at a time in batches of{" "}
                {sources?.scan_batch_size ?? 100}.
              </p>
            </div>

            <div className="space-y-2.5">
              <label className="flex items-start gap-2.5 text-sm">
                <Checkbox
                  checked={force}
                  onCheckedChange={(value) => setForce(value === true)}
                  className="mt-0.5"
                />
                <span>
                  Re-check verified domains
                  <span className="block text-xs text-muted-foreground">
                    Ignores the {sources?.rdap_cache_hours ?? 24}h RDAP cache
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 text-sm">
                <Checkbox
                  checked={enrich}
                  onCheckedChange={(value) => setEnrich(value === true)}
                  className="mt-0.5"
                />
                <span>
                  Run SEO analysis afterwards
                  <span className="block text-xs text-muted-foreground">
                    Only for expiring, expired, redemption and pending-delete domains
                  </span>
                </span>
              </label>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleStart}
                disabled={isStarting || selectedKinds.length === 0}
              >
                {isStarting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ScanSearch className="size-4" />
                )}
                Start Scan
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export default DomainScanDialog
