import {
  ArrowDown,
  ArrowUp,
  Copy,
  Download,
  Eye,
  Inbox,
  MoreHorizontal,
  RotateCw,
  Star,
  TriangleAlert,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

import MetricValue from "./MetricValue"
import {
  categoryBadgeClass,
  categoryLabel,
  daysToneClass,
  seoBand,
  spamBadgeClass,
} from "./domainVisuals"
import { formatDate, type DomainListResponse, type DomainQuery, type DomainRecord } from "./types"

/* Column meta drives the header, the sort keys and the responsive hiding. */
const COLUMNS = [
  { label: "", key: "", className: "w-8" },
  { label: "Domain", key: "domain", className: "" },
  { label: "Lifecycle", key: "category", className: "hidden md:table-cell" },
  { label: "Expiry", key: "days_left", className: "" },
  { label: "RD", key: "referring_domains", className: "hidden lg:table-cell" },
  { label: "Backlinks", key: "total_backlinks", className: "hidden xl:table-cell" },
  { label: "Topic", key: "primary_topic", className: "hidden lg:table-cell" },
  { label: "Spam", key: "spam_risk_score", className: "hidden sm:table-cell" },
  { label: "SEO", key: "seo_score", className: "" },
  { label: "Last Checked", key: "last_rdap_checked", className: "hidden xl:table-cell" },
  { label: "", key: "", className: "w-10" },
] as const

function compact(value: number | null): string | null {
  if (value === null) return null
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`
  return String(value)
}

function SeoScore({ record }: { record: DomainRecord }) {
  const band = seoBand(record.seo_score)
  if (record.seo_score === null) {
    return (
      <span className="text-muted-foreground" title={record.seo_unscored_reason ?? "Not scored"}>
        —
      </span>
    )
  }
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={cn("tabular font-medium", band.tone)}>{record.seo_score}</span>
      {record.seo_confidence && record.seo_confidence !== "Full" && (
        <span
          className="text-[10px] text-muted-foreground"
          title={`Score computed from ${record.seo_coverage_pct}% of the model`}
        >
          {record.seo_confidence[0]}
        </span>
      )}
    </span>
  )
}

function RowActions({
  record,
  onView,
  onCopy,
  onRecheck,
  onExportRow,
  onToggleWatchlist,
}: {
  record: DomainRecord
  onView: (record: DomainRecord) => void
  onCopy: (record: DomainRecord) => void
  onRecheck: (record: DomainRecord) => void
  onExportRow: (record: DomainRecord) => void
  onToggleWatchlist: (record: DomainRecord) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          aria-label={`Actions for ${record.domain}`}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={() => onView(record)}>
          <Eye className="size-4" />
          View details
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onToggleWatchlist(record)}>
          <Star className={cn("size-4", record.watchlisted && "fill-current")} />
          {record.watchlisted ? "Remove from watchlist" : "Add to watchlist"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCopy(record)}>
          <Copy className="size-4" />
          Copy domain
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onRecheck(record)}>
          <RotateCw className="size-4" />
          Recheck
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onExportRow(record)}>
          <Download className="size-4" />
          Export row
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DomainTable({
  data,
  query,
  isLoading,
  error,
  hasFilters,
  noSourcesConfigured,
  selected,
  onToggleSelected,
  onSort,
  onPage,
  onRetry,
  onView,
  onCopy,
  onRecheck,
  onExportRow,
  onToggleWatchlist,
  onImport,
  onConfigureSources,
}: {
  data: DomainListResponse | null
  query: DomainQuery
  isLoading: boolean
  error: string | null
  hasFilters: boolean
  noSourcesConfigured: boolean
  selected: string[]
  onToggleSelected: (domain: string) => void
  onSort: (key: string) => void
  onPage: (page: number) => void
  onRetry: () => void
  onView: (record: DomainRecord) => void
  onCopy: (record: DomainRecord) => void
  onRecheck: (record: DomainRecord) => void
  onExportRow: (record: DomainRecord) => void
  onToggleWatchlist: (record: DomainRecord) => void
  onImport: () => void
  onConfigureSources: () => void
}) {
  if (error) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>Unable to load domain data.</AlertTitle>
        <AlertDescription>
          <p>{error}</p>
          <Button variant="outline" size="sm" onClick={onRetry} className="mt-1">
            Try Again
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  if (isLoading && !data) {
    return (
      <div className="rounded-lg border">
        <div className="space-y-px p-1">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="flex items-center gap-4 px-3 py-2.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="hidden h-4 w-24 md:block" />
              <Skeleton className="h-4 w-12" />
              <Skeleton className="ml-auto h-5 w-16" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (!data || data.items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-14 text-center">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
          <Inbox className="size-5 text-muted-foreground" />
        </div>
        <h3 className="mt-3 text-sm font-semibold">
          {hasFilters
            ? "No domains match these filters"
            : noSourcesConfigured
              ? "No domain sources configured"
              : "No domains monitored yet"}
        </h3>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {hasFilters
            ? "Try widening the search or clearing a filter."
            : noSourcesConfigured
              ? "Configure a domain source or import a TXT/CSV list to begin monitoring."
              : "Run a scan to discover candidates from your configured sources."}
        </p>
        {!hasFilters && (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" onClick={onImport}>
              Import Domains
            </Button>
            {noSourcesConfigured && (
              <Button size="sm" variant="outline" onClick={onConfigureSources}>
                Configure Sources
              </Button>
            )}
          </div>
        )}
      </div>
    )
  }

  const rows = data.items

  return (
    <div className={cn("space-y-3", isLoading && "opacity-60 transition-opacity")}>
      <div className="hidden rounded-lg border sm:block">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {COLUMNS.map((column, index) => {
                  const isSorted = Boolean(column.key) && query.sort === column.key
                  return (
                    <TableHead
                      key={column.label || `col-${index}`}
                      className={column.className}
                    >
                      {column.key ? (
                        <button
                          type="button"
                          onClick={() => onSort(column.key)}
                          className="-mx-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 hover:text-foreground"
                        >
                          {column.label}
                          {isSorted &&
                            (query.order === "asc" ? (
                              <ArrowUp className="size-3" />
                            ) : (
                              <ArrowDown className="size-3" />
                            ))}
                        </button>
                      ) : (
                        column.label
                      )}
                    </TableHead>
                  )
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((record) => (
                <TableRow key={record.domain}>
                  <TableCell>
                    <Checkbox
                      checked={selected.includes(record.domain)}
                      onCheckedChange={() => onToggleSelected(record.domain)}
                      aria-label={`Select ${record.domain} for comparison`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onView(record)}
                        className="text-left font-medium hover:underline"
                      >
                        {record.domain}
                      </button>
                      {record.watchlisted && (
                        <Star className="size-3 shrink-0 fill-current text-caution" />
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">{record.tld}</div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Badge className={cn("rounded-md", categoryBadgeClass(record.category))}>
                      {categoryLabel(record.category)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {record.days_left === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className={cn("tabular", daysToneClass(record.category))}>
                        {record.days_left}d
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <MetricValue value={record.referring_domains} />
                  </TableCell>
                  <TableCell className="hidden xl:table-cell">
                    {record.total_backlinks === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="tabular">{compact(record.total_backlinks)}</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {record.primary_topic ? (
                      <span className="text-xs">{record.primary_topic}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {record.spam_risk_level ? (
                      <Badge
                        className={cn("rounded-md", spamBadgeClass(record.spam_risk_level))}
                      >
                        {record.spam_risk_level}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <SeoScore record={record} />
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground xl:table-cell">
                    {formatDate(record.last_rdap_checked ?? record.last_checked)}
                  </TableCell>
                  <TableCell>
                    <RowActions
                      record={record}
                      onView={onView}
                      onCopy={onCopy}
                      onRecheck={onRecheck}
                      onExportRow={onExportRow}
                      onToggleWatchlist={onToggleWatchlist}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Mobile: an eleven-column table at 360px is unreadable, so use cards. */}
      <div className="space-y-2 sm:hidden">
        {rows.map((record) => {
          const band = seoBand(record.seo_score)
          return (
            <div key={record.domain} className="rounded-lg border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{record.domain}</span>
                    {record.watchlisted && (
                      <Star className="size-3 shrink-0 fill-current text-caution" />
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{record.tld}</div>
                </div>
                <span className={cn("tabular text-lg font-semibold leading-none", band.tone)}>
                  {record.seo_score ?? "—"}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge className={cn("rounded-md", categoryBadgeClass(record.category))}>
                  {categoryLabel(record.category)}
                </Badge>
                {record.spam_risk_level && (
                  <Badge className={cn("rounded-md", spamBadgeClass(record.spam_risk_level))}>
                    Spam {record.spam_risk_level}
                  </Badge>
                )}
                {record.primary_topic && (
                  <Badge variant="outline" className="rounded-md font-normal">
                    {record.primary_topic}
                  </Badge>
                )}
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Expires</dt>
                  <dd>{formatDate(record.expiration_date)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Days Left</dt>
                  <dd>
                    <MetricValue value={record.days_left} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Referring Domains</dt>
                  <dd>
                    <MetricValue value={record.referring_domains} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Domain Age</dt>
                  <dd>
                    <MetricValue value={record.domain_age_years} suffix=" y" />
                  </dd>
                </div>
              </dl>

              <div className="mt-3 flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => onView(record)}
                >
                  <Eye className="size-3.5" />
                  View
                </Button>
                <RowActions
                  record={record}
                  onView={onView}
                  onCopy={onCopy}
                  onRecheck={onRecheck}
                  onExportRow={onExportRow}
                  onToggleWatchlist={onToggleWatchlist}
                />
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span className="tabular">
          {(data.page - 1) * data.limit + 1}–
          {Math.min(data.page * data.limit, data.total)} of {data.total.toLocaleString()}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPage(data.page - 1)}
            disabled={data.page <= 1}
          >
            Previous
          </Button>
          <span className="tabular text-xs">
            Page {data.page} of {Math.max(data.pages, 1)}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPage(data.page + 1)}
            disabled={data.page >= data.pages}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}

export default DomainTable
