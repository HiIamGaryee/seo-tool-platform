import { useEffect, useState } from "react"
import { Loader2, Star } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

import AnchorProfilePanel from "./AnchorProfilePanel"
import HistoryTimeline from "./HistoryTimeline"
import MetricValue from "./MetricValue"
import ScoreBreakdown from "./ScoreBreakdown"
import SpamPanel from "./SpamPanel"
import {
  categoryBadgeClass,
  categoryLabel,
  priorityDotClass,
  relevanceBadgeClass,
  stabilityTone,
} from "./domainVisuals"
import { formatDate, type DomainDetail } from "./types"

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{value}</dd>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {children}
    </div>
  )
}

function archiveYear(timestamp: string | null): string {
  if (!timestamp) return "—"
  return timestamp.slice(0, 4)
}

function DomainDetailSheet({
  record,
  isLoadingDetail,
  onOpenChange,
  onSaveWatchlist,
}: {
  record: DomainDetail | null
  isLoadingDetail: boolean
  onOpenChange: (open: boolean) => void
  onSaveWatchlist: (domain: string, watchlisted: boolean, notes: string) => Promise<void>
}) {
  const [note, setNote] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setNote(record?.notes ?? "")
  }, [record?.domain, record?.notes])

  const handleSave = async (watchlisted: boolean) => {
    if (!record) return
    setIsSaving(true)
    try {
      await onSaveWatchlist(record.domain, watchlisted, note)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Sheet open={Boolean(record)} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        {record && (
          <>
            <SheetHeader className="gap-2">
              <SheetTitle className="break-all text-lg">{record.domain}</SheetTitle>
              <SheetDescription className="sr-only">
                SEO and lifecycle detail for {record.domain}
              </SheetDescription>
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={cn("rounded-md", categoryBadgeClass(record.category))}>
                  {categoryLabel(record.category)}
                </Badge>
                <Badge variant="outline" className="gap-1.5 rounded-md font-normal">
                  <span
                    className={cn("size-1.5 rounded-full", priorityDotClass(record.priority))}
                  />
                  {record.priority}
                </Badge>
                {record.primary_topic && (
                  <Badge variant="outline" className="rounded-md font-normal">
                    {record.primary_topic}
                  </Badge>
                )}
                {isLoadingDetail && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
              </div>
            </SheetHeader>

            <div className="space-y-5 px-4 pb-6">
              <Section title="SEO Opportunity Score">
                <ScoreBreakdown record={record} />
              </Section>

              <Separator />

              <Section title="Domain Lifecycle">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <Field label="Status" value={categoryLabel(record.category)} />
                  <Field label="Expiration" value={formatDate(record.expiration_date)} />
                  <Field
                    label="Days Left"
                    value={<MetricValue value={record.days_left} />}
                  />
                  <Field label="Registrar" value={record.registrar || "Unknown"} />
                  <Field
                    label="Domain Age"
                    value={<MetricValue value={record.domain_age_years} suffix=" years" decimals={1} />}
                  />
                  <Field label="Created" value={formatDate(record.registration_date)} />
                </dl>
                <div className="mt-2.5">
                  <div className="text-xs text-muted-foreground">Registry status</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {record.registry_status.length > 0 ? (
                      record.registry_status.map((status) => (
                        <Badge key={status} variant="outline" className="rounded-md font-normal">
                          {status}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-sm text-muted-foreground">Not published</span>
                    )}
                  </div>
                </div>
              </Section>

              <Separator />

              <Section title="Backlink Profile">
                {record.referring_domains === null ? (
                  <p className="text-sm text-muted-foreground">
                    {record.backlink_error ?? "Backlink data unavailable"}
                  </p>
                ) : (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                    <Field
                      label="Referring Domains"
                      value={<MetricValue value={record.referring_domains} />}
                    />
                    <Field
                      label="Total Backlinks"
                      value={<MetricValue value={record.total_backlinks} />}
                    />
                    <Field
                      label="Follow"
                      value={
                        <MetricValue
                          value={
                            record.follow_backlinks !== null && record.total_backlinks
                              ? (record.follow_backlinks / record.total_backlinks) * 100
                              : null
                          }
                          suffix="%"
                        />
                      }
                    />
                    <Field
                      label="NoFollow"
                      value={
                        <MetricValue
                          value={
                            record.nofollow_backlinks !== null && record.total_backlinks
                              ? (record.nofollow_backlinks / record.total_backlinks) * 100
                              : null
                          }
                          suffix="%"
                        />
                      }
                    />
                    <Field
                      label="Lost Backlinks"
                      value={<MetricValue value={record.lost_backlinks} />}
                    />
                    <Field label="Provider" value={record.backlink_provider || "—"} />
                  </dl>
                )}
              </Section>

              <Separator />

              <Section title="Top Anchors">
                <AnchorProfilePanel record={record} />
              </Section>

              <Separator />

              <Section title="Historical SEO">
                <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-3">
                  <Field label="First Seen" value={archiveYear(record.first_archive_seen)} />
                  <Field label="Last Seen" value={archiveYear(record.last_archive_seen)} />
                  <Field
                    label="Archive Captures"
                    value={
                      <span>
                        <MetricValue value={record.snapshot_count} />
                        {record.snapshot_count_truncated && (
                          <span className="ml-1 text-xs text-muted-foreground">(capped)</span>
                        )}
                      </span>
                    }
                  />
                  <Field label="Historical Topic" value={record.historical_topic || "—"} />
                  <Field
                    label="Stability"
                    value={
                      <span className={stabilityTone(record.historical_stability)}>
                        {record.historical_stability ?? "—"}
                      </span>
                    }
                  />
                  <Field
                    label="Relevance"
                    value={
                      record.relevance_band ? (
                        <Badge
                          className={cn("rounded-md", relevanceBadgeClass(record.relevance_band))}
                        >
                          {record.relevance_band}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">no niches set</span>
                      )
                    }
                  />
                </dl>
                <HistoryTimeline snapshots={record.snapshots} />
              </Section>

              <Separator />

              <Section title="Spam Analysis">
                <SpamPanel record={record} />
              </Section>

              <Separator />

              <Section title="Watchlist">
                <Textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={2}
                  placeholder="e.g. Check if it reaches pendingDelete."
                  className="resize-none text-sm"
                />
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant={record.watchlisted ? "secondary" : "default"}
                    onClick={() => handleSave(!record.watchlisted)}
                    disabled={isSaving}
                  >
                    {isSaving ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Star className={cn("size-4", record.watchlisted && "fill-current")} />
                    )}
                    {record.watchlisted ? "Remove" : "Add to Watchlist"}
                  </Button>
                  {record.watchlisted && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleSave(true)}
                      disabled={isSaving}
                    >
                      Save note
                    </Button>
                  )}
                </div>
              </Section>

              <Separator />

              <Section title="Refresh & Sources">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <Field label="RDAP checked" value={formatDate(record.last_rdap_checked)} />
                  <Field label="Backlink refresh" value={formatDate(record.last_backlink_checked)} />
                  <Field label="Archive refresh" value={formatDate(record.last_history_checked)} />
                  <Field label="Candidate source" value={record.source || "Unknown"} />
                  <Field
                    label="RDAP source"
                    value={
                      <span className="break-all font-mono text-xs">
                        {record.rdap_source || "Unknown"}
                      </span>
                    }
                  />
                  <Field
                    label="Availability"
                    value={
                      record.available === null
                        ? "Not determined"
                        : record.available
                          ? "Reported available"
                          : "Reported registered"
                    }
                  />
                </dl>
              </Section>

              <p className="rounded-md bg-muted px-3 py-2.5 text-xs text-muted-foreground">
                Expiry date and registry status are tracked separately. A domain
                that is expired, in redemption or pending delete is not
                necessarily available to register.
              </p>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

export default DomainDetailSheet
