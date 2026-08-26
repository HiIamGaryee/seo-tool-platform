import { TriangleAlert } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

import MetricValue from "./MetricValue"
import { spamBadgeClass, stabilityTone } from "./domainVisuals"
import type { DomainRecord } from "./types"

function SpamPanel({ record }: { record: DomainRecord }) {
  if (record.spam_risk_score === null) {
    return (
      <p className="text-sm text-muted-foreground">
        Not enough history or link data to assess spam risk.
      </p>
    )
  }

  const isElevated = record.spam_risk_level === "High" || record.spam_risk_level === "Very High"

  return (
    <div className="space-y-3">
      {isElevated && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>High SEO risk</AlertTitle>
          <AlertDescription>
            <ul className="space-y-0.5">
              {record.spam_signals.map((signal) => (
                <li key={signal.code}>{signal.detail}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Rule-based spam risk</dt>
          <dd>
            <Badge className={cn("rounded-md", spamBadgeClass(record.spam_risk_level))}>
              {record.spam_risk_level}
            </Badge>
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Spam score</dt>
          <dd>
            <MetricValue value={record.spam_risk_score} suffix=" / 100" />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Suspicious anchors</dt>
          <dd>
            <MetricValue value={record.suspicious_anchor_pct} suffix="%" decimals={1} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Topic changes</dt>
          <dd>
            <MetricValue value={record.topic_switch_count} />
          </dd>
        </div>
      </dl>

      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">Historical stability</span>
        <span className={cn("font-medium", stabilityTone(record.historical_stability))}>
          {record.historical_stability ?? "—"}
        </span>
      </div>

      <div>
        <div className="mb-1.5 text-xs text-muted-foreground">Detected spam categories</div>
        {record.spam_categories.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {record.spam_categories.map((category) => (
              <Badge
                key={category}
                className="rounded-md border-critical/25 bg-critical/10 text-critical"
              >
                {category}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">None</span>
        )}
      </div>

      {record.spam_signals.length > 0 && !isElevated && (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {record.spam_signals.map((signal) => (
            <li key={signal.code} className="flex justify-between gap-3">
              <span>{signal.detail}</span>
              <span className="tabular shrink-0">+{signal.points}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        Rule-based risk from configured keyword and threshold checks. Not a
        Google penalty signal.
      </p>
    </div>
  )
}

export default SpamPanel
