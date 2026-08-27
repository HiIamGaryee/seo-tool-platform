import { cn } from "@/lib/utils"

import type { ArchiveSnapshot } from "./types"

/**
 * Archive timeline built from sampled Wayback snapshots.
 *
 * Titles are the real archived <title> values; the topic beside each is the
 * rule-based keyword match for that snapshot, not a summary of the page.
 */
function HistoryTimeline({ snapshots }: { snapshots: ArchiveSnapshot[] }) {
  if (snapshots.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No archive snapshots captured.</p>
    )
  }

  return (
    <ol className="relative space-y-3 border-l pl-4">
      {snapshots.map((snapshot, index) => (
        <li key={`${snapshot.timestamp}-${index}`} className="relative">
          <span
            aria-hidden
            className={cn(
              "absolute -left-[21px] top-1.5 size-2 rounded-full border-2 border-background",
              snapshot.topic ? "bg-primary" : "bg-muted-foreground",
            )}
          />
          <div className="flex items-baseline gap-2">
            <span className="tabular text-sm font-medium">{snapshot.year ?? "—"}</span>
            {snapshot.topic && (
              <span className="text-xs text-muted-foreground">{snapshot.topic}</span>
            )}
            {snapshot.is_redirect && (
              <span className="text-xs text-caution">redirect</span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {snapshot.title || <span className="italic">no title archived</span>}
          </p>
        </li>
      ))}
    </ol>
  )
}

export default HistoryTimeline
