import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { categoryBadgeClass, categoryLabel, seoBand, spamBadgeClass } from "./domainVisuals"
import type { DomainRecord } from "./types"

const ROWS = [
  {
    label: "SEO Score",
    render: (r: DomainRecord) => (
      <span className={cn("tabular font-medium", seoBand(r.seo_score).tone)}>
        {r.seo_score === null ? "—" : r.seo_score}
      </span>
    ),
  },
  { label: "Referring Domains", render: (r: DomainRecord) => <MetricValue value={r.referring_domains} /> },
  { label: "Backlinks", render: (r: DomainRecord) => <MetricValue value={r.total_backlinks} /> },
  {
    label: "Domain Age",
    render: (r: DomainRecord) => <MetricValue value={r.domain_age_years} suffix=" y" decimals={1} />,
  },
  {
    label: "Topic",
    render: (r: DomainRecord) =>
      r.primary_topic ? (
        <Badge variant="outline" className="rounded-md font-normal">
          {r.primary_topic}
        </Badge>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    label: "Spam Risk",
    render: (r: DomainRecord) => (
      <Badge className={cn("rounded-md", spamBadgeClass(r.spam_risk_level))}>
        {r.spam_risk_level ?? "—"}
      </Badge>
    ),
  },
  {
    label: "Lifecycle",
    render: (r: DomainRecord) => (
      <Badge className={cn("rounded-md", categoryBadgeClass(r.category))}>
        {categoryLabel(r.category)}
      </Badge>
    ),
  },
  {
    label: "Archive Captures",
    render: (r: DomainRecord) => <MetricValue value={r.snapshot_count} />,
  },
  {
    label: "Score Confidence",
    render: (r: DomainRecord) => (
      <span className="text-xs text-muted-foreground">{r.seo_confidence ?? "—"}</span>
    ),
  },
]

function CompareDialog({
  isOpen,
  onOpenChange,
  items,
}: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  items: DomainRecord[]
}) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Compare Domains</DialogTitle>
          <DialogDescription>
            Side by side across the same rule-based metrics.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-40">Metric</TableHead>
                {items.map((item) => (
                  <TableHead key={item.domain} className="font-medium text-foreground">
                    {item.domain}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {ROWS.map((row) => (
                <TableRow key={row.label}>
                  <TableCell className="text-muted-foreground">{row.label}</TableCell>
                  {items.map((item) => (
                    <TableCell key={item.domain}>{row.render(item)}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default CompareDialog
