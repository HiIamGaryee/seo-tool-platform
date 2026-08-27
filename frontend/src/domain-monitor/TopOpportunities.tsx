import { Target } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

import MetricValue from "./MetricValue"
import { categoryBadgeClass, categoryLabel, seoBand, spamBadgeClass } from "./domainVisuals"
import type { DomainRecord } from "./types"

/**
 * Shortlist of the highest scoring domains. A companion to the main table, not
 * a replacement: only rows that actually carry a score can appear here.
 */
function TopOpportunities({
  items,
  isLoading,
  onView,
}: {
  items: DomainRecord[] | null
  isLoading: boolean
  onView: (record: DomainRecord) => void
}) {
  if (isLoading && !items) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Card key={index}>
            <CardContent className="px-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-3 h-6 w-16" />
              <Skeleton className="mt-3 h-4 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  if (!items || items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed px-4 py-6 text-center">
        <Target className="mx-auto size-5 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">No scored domains yet</p>
        <p className="text-xs text-muted-foreground">
          Run an SEO enrichment pass to score the monitored domains.
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((record) => {
        const band = seoBand(record.seo_score)
        return (
          <Card key={record.domain} className="gap-0 py-3">
            <CardContent className="px-4">
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  onClick={() => onView(record)}
                  className="min-w-0 truncate text-left text-sm font-medium hover:underline"
                >
                  {record.domain}
                </button>
                <span className={cn("tabular shrink-0 text-xl font-semibold leading-none", band.tone)}>
                  {record.seo_score}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge className={cn("rounded-md", categoryBadgeClass(record.category))}>
                  {categoryLabel(record.category)}
                </Badge>
                <Badge className={cn("rounded-md", spamBadgeClass(record.spam_risk_level))}>
                  Spam {record.spam_risk_level ?? "—"}
                </Badge>
                {record.primary_topic && (
                  <Badge variant="outline" className="rounded-md font-normal">
                    {record.primary_topic}
                  </Badge>
                )}
              </div>

              <dl className="mt-2.5 flex items-center gap-4 text-xs text-muted-foreground">
                <div className="flex gap-1">
                  <dt>RD</dt>
                  <dd>
                    <MetricValue value={record.referring_domains} className="text-foreground" />
                  </dd>
                </div>
                <div className="flex gap-1">
                  <dt>Age</dt>
                  <dd>
                    <MetricValue
                      value={record.domain_age_years}
                      suffix="y"
                      className="text-foreground"
                    />
                  </dd>
                </div>
                {record.seo_confidence !== "Full" && (
                  <div className="ml-auto">{record.seo_confidence} data</div>
                )}
              </dl>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

export default TopOpportunities
