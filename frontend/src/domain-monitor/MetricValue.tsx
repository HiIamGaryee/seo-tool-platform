import { cn } from "@/lib/utils"

/**
 * Renders a metric that may genuinely be unmeasured.
 *
 * The whole dashboard depends on one rule: null means "not available" and shows
 * an em dash, while 0 means the source really reported zero. Routing every
 * metric through here keeps that distinction from drifting.
 */
function MetricValue({
  value,
  suffix,
  decimals = 0,
  className,
  unavailableLabel = "—",
  title,
}: {
  value: number | null | undefined
  suffix?: string
  decimals?: number
  className?: string
  unavailableLabel?: string
  title?: string
}) {
  if (value === null || value === undefined) {
    return (
      <span
        className={cn("text-muted-foreground", className)}
        title={title ?? "Not available"}
      >
        {unavailableLabel}
      </span>
    )
  }

  const formatted =
    decimals > 0
      ? value.toFixed(decimals)
      : Math.round(value).toLocaleString()

  return (
    <span className={cn("tabular", className)}>
      {formatted}
      {suffix}
    </span>
  )
}

export default MetricValue
