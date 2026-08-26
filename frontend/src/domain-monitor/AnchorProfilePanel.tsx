import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

import MetricValue from "./MetricValue"
import { anchorKindLabel } from "./domainVisuals"
import type { DomainRecord } from "./types"

const KIND_TONE: Record<string, string> = {
  branded: "bg-success",
  generic: "bg-muted-foreground",
  exact_match: "bg-caution",
  other: "bg-info",
}

const DISTRIBUTION = [
  { key: "branded_pct", label: "Branded" },
  { key: "exact_match_pct", label: "Exact match" },
  { key: "generic_pct", label: "Generic" },
  { key: "suspicious_anchor_pct", label: "Suspicious" },
] as const

function AnchorProfilePanel({ record }: { record: DomainRecord }) {
  if (record.anchor_total === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {record.backlink_error ?? "Backlink data unavailable"}
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {DISTRIBUTION.map((item) => (
          <div key={item.key} className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">{item.label}</dt>
            <dd>
              <MetricValue value={record[item.key]} suffix="%" decimals={1} />
            </dd>
          </div>
        ))}
      </dl>

      {record.top_anchors.length > 0 ? (
        <ul className="space-y-1.5">
          {record.top_anchors.map((anchor) => (
            <li key={anchor.text} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="min-w-0 truncate" title={anchor.text}>
                  {anchor.text}
                </span>
                <span className="tabular shrink-0 text-muted-foreground">
                  {anchor.share_pct}%
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full", KIND_TONE[anchor.kind] ?? "bg-info")}
                    style={{ width: `${Math.min(100, anchor.share_pct)}%` }}
                  />
                </div>
                <Badge variant="outline" className="rounded-md px-1.5 py-0 text-[10px] font-normal">
                  {anchorKindLabel(anchor.kind)}
                </Badge>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          Provider returned no anchor text for this domain.
        </p>
      )}
    </div>
  )
}

export default AnchorProfilePanel
