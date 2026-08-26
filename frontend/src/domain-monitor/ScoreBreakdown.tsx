import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

import MetricValue from "./MetricValue"
import { confidenceTone, seoBand } from "./domainVisuals"
import type { DomainRecord } from "./types"

/**
 * The full SEO Opportunity Score breakdown.
 *
 * Components with no data show an em dash and are excluded from the total; the
 * backend renormalises over what it could measure and reports the coverage,
 * which is surfaced here so a partial score is never mistaken for a full one.
 */
function ScoreBreakdown({ record }: { record: DomainRecord }) {
  const band = seoBand(record.seo_score)

  if (record.seo_score === null) {
    return (
      <div className="rounded-lg border border-dashed p-3">
        <div className="text-sm font-medium">Not scored</div>
        <p className="mt-1 text-xs text-muted-foreground">
          {record.seo_unscored_reason ??
            "Not enough data was available to compute a score."}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-1.5">
            <span className={cn("tabular text-3xl font-semibold leading-none", band.tone)}>
              {record.seo_score}
            </span>
            <span className="text-sm text-muted-foreground">/ 100</span>
          </div>
          <div className={cn("mt-1 text-xs font-medium", band.tone)}>{band.label}</div>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div className={confidenceTone(record.seo_confidence)}>
            {record.seo_confidence ?? "—"} confidence
          </div>
          <div>
            <MetricValue value={record.seo_coverage_pct} suffix="%" /> of model used
          </div>
        </div>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-[width]", band.bar)}
          style={{ width: `${record.seo_score}%` }}
        />
      </div>

      <dl className="space-y-1.5 text-sm">
        {record.score_components.map((component) => (
          <div key={component.key} className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0">
              <span className={component.available ? "" : "text-muted-foreground"}>
                {component.label}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {component.detail}
              </span>
            </dt>
            <dd className="shrink-0 text-right">
              {component.awarded === null ? (
                <span className="text-muted-foreground" title="Not available">
                  —
                </span>
              ) : (
                <span className="tabular">
                  {component.awarded} <span className="text-muted-foreground">/ {component.weight}</span>
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>

      <Separator />

      <dl className="space-y-1 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Base score</dt>
          <dd>
            <MetricValue value={record.seo_base_score} />
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Spam penalty</dt>
          <dd className={record.spam_penalty ? "text-destructive" : undefined}>
            {record.spam_penalty ? `−${record.spam_penalty}` : "0"}
          </dd>
        </div>
        <div className="flex items-center justify-between font-medium">
          <dt>Total</dt>
          <dd className="tabular">{record.seo_score} / 100</dd>
        </div>
      </dl>

      {record.score_reasons.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            Why this scored well
          </div>
          <ul className="space-y-1 text-xs">
            {record.score_reasons.map((reason) => (
              <li key={reason} className="flex gap-2">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-success" />
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {record.score_concerns.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            What held it back
          </div>
          <ul className="space-y-1 text-xs">
            {record.score_concerns.map((concern) => (
              <li key={concern} className="flex gap-2">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-caution" />
                <span>{concern}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Internal rule-based score. Every point above comes from a configured
        threshold, not from a model, and it is not a Google metric.
      </p>
    </div>
  )
}

export default ScoreBreakdown
