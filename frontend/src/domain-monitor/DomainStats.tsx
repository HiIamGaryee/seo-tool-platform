import { ChevronRight } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

import { PRIMARY_STAT_CARDS, SECONDARY_STAT_CARDS, STAT_CARDS } from "./domainVisuals"
import { formatDate } from "./types"
import type { DomainStatsResponse } from "./types"

/* Truthful sublines only: the API exposes no per-scan deltas, so nothing here
   claims a change it cannot measure. */
function subline(card: (typeof STAT_CARDS)[number], stats: DomainStatsResponse): string {
  if (card.key === "total") {
    return stats.refreshed.rdap
      ? `RDAP ${formatDate(stats.refreshed.rdap)}`
      : "Never scanned"
  }
  if (card.key === "high_opportunity") {
    return stats.scored > 0
      ? `score ≥ ${stats.high_opportunity_min}, of ${stats.scored.toLocaleString()} scored`
      : "no domains scored yet"
  }
  if (card.key === "high_spam_risk") {
    return stats.scored > 0 ? "High or Very High risk" : "not assessed yet"
  }
  if (!stats.total) return "no domains yet"
  return `${Math.round((stats[card.key] / stats.total) * 100)}% of monitored`
}

function StatCardTile({
  card,
  stats,
}: {
  card: (typeof STAT_CARDS)[number]
  stats: DomainStatsResponse
}) {
  return (
    <Card className="gap-0 py-4">
      <CardContent className="px-4">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-medium text-muted-foreground">
            {card.label}
          </span>
          <card.icon className={cn("size-4 shrink-0", card.tone)} />
        </div>
        <div className="tabular mt-2 text-3xl font-semibold leading-none">
          {stats[card.key].toLocaleString()}
        </div>
        <div className="mt-1.5 truncate text-xs text-muted-foreground">
          {subline(card, stats)}
        </div>
      </CardContent>
    </Card>
  )
}

function DomainStats({ stats }: { stats: DomainStatsResponse | null }) {
  if (!stats) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {PRIMARY_STAT_CARDS.map((card) => (
          <Card key={card.key}>
            <CardContent className="px-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-3 h-7 w-14" />
              <Skeleton className="mt-2 h-3 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {PRIMARY_STAT_CARDS.map((card) => (
          <StatCardTile key={card.key} card={card} stats={stats} />
        ))}
      </div>

      <Collapsible className="rounded-lg border">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2.5 text-left [&[data-state=open]>svg]:rotate-90">
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform duration-200" />
          <span className="text-sm font-medium">SEO Summary</span>
          <span className="text-xs text-muted-foreground">
            {stats.high_opportunity.toLocaleString()} high opportunity ·{" "}
            {stats.high_spam_risk.toLocaleString()} high spam risk
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid gap-3 px-3 pb-3 sm:grid-cols-2">
            {SECONDARY_STAT_CARDS.map((card) => (
              <StatCardTile key={card.key} card={card} stats={stats} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

export default DomainStats
