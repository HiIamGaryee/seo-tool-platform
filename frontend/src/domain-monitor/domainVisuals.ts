import {
  CalendarClock,
  CalendarDays,
  CircleAlert,
  Globe2,
  ShieldAlert,
  Target,
  Trash2,
  type LucideIcon,
} from "lucide-react"

import type {
  DomainCategory,
  DomainPriority,
  RelevanceBand,
  ScoreConfidence,
  SpamLevel,
} from "./types"

/* Severity ramp, loudest first: filled red -> red tint -> orange -> amber ->
   neutral -> green -> outline. Every colour here comes from a design token, so
   components never name a colour themselves. */
const CATEGORY_BADGE: Record<DomainCategory, string> = {
  "Pending Delete": "border-transparent bg-destructive text-white",
  Redemption: "border-critical/25 bg-critical/10 text-critical",
  Expired: "border-severe/25 bg-severe/10 text-severe",
  "Expiring <=30 Days": "border-caution/25 bg-caution/10 text-caution",
  "Expiring 31-60 Days": "border-transparent bg-secondary text-secondary-foreground",
  Safe: "border-success/25 bg-success/10 text-success",
  Unknown: "border-border text-muted-foreground",
}

const PRIORITY_DOT: Record<DomainPriority, string> = {
  Critical: "bg-destructive",
  "Very High": "bg-critical",
  High: "bg-severe",
  Medium: "bg-caution",
  Watch: "bg-info",
  Low: "bg-success",
  Unknown: "bg-muted-foreground",
}

/* Days-left colouring mirrors the category ramp so the number itself carries
   the lifecycle signal without needing a separate column. */
const DAYS_TONE: Record<DomainCategory, string> = {
  "Pending Delete": "text-destructive font-medium",
  Redemption: "text-critical font-medium",
  Expired: "text-severe font-medium",
  "Expiring <=30 Days": "text-caution font-medium",
  "Expiring 31-60 Days": "text-foreground",
  Safe: "text-muted-foreground",
  Unknown: "text-muted-foreground",
}

export function categoryBadgeClass(category: string): string {
  return CATEGORY_BADGE[category as DomainCategory] ?? CATEGORY_BADGE.Unknown
}

export function priorityDotClass(priority: string): string {
  return PRIORITY_DOT[priority as DomainPriority] ?? PRIORITY_DOT.Unknown
}

export function daysToneClass(category: string): string {
  return DAYS_TONE[category as DomainCategory] ?? DAYS_TONE.Unknown
}

/* Shortened labels for dense surfaces (tabs, table, mobile cards). */
const SHORT_LABEL: Record<DomainCategory, string> = {
  "Pending Delete": "Pending Delete",
  Redemption: "Redemption",
  Expired: "Expired",
  "Expiring <=30 Days": "≤30 Days",
  "Expiring 31-60 Days": "31–60 Days",
  Safe: "Safe",
  Unknown: "Unknown",
}

export function categoryLabel(category: string): string {
  return SHORT_LABEL[category as DomainCategory] ?? category
}

export type StatCardKey =
  | "total"
  | "expired"
  | "expiring_30"
  | "expiring_31_60"
  | "redemption"
  | "pending_delete"
  | "high_opportunity"
  | "high_spam_risk"

export type StatCard = {
  key: StatCardKey
  label: string
  icon: LucideIcon
  tone: string
}

/* The lifecycle counts that drive the daily workflow. Capped at five so a
   desktop row stays readable instead of squeezing seven cards together. */
export const PRIMARY_STAT_CARDS: StatCard[] = [
  { key: "total", label: "Total Domains", icon: Globe2, tone: "text-muted-foreground" },
  { key: "expired", label: "Expired", icon: CircleAlert, tone: "text-severe" },
  { key: "expiring_30", label: "≤30 Days", icon: CalendarDays, tone: "text-caution" },
  { key: "expiring_31_60", label: "31–60 Days", icon: CalendarClock, tone: "text-info" },
  { key: "pending_delete", label: "Pending Delete", icon: Trash2, tone: "text-destructive" },
]

/* Quality signals rather than lifecycle urgency: useful, but not what the page
   is for. These live behind the SEO Summary disclosure. */
export const SECONDARY_STAT_CARDS: StatCard[] = [
  { key: "high_opportunity", label: "High SEO Opportunity", icon: Target, tone: "text-success" },
  { key: "high_spam_risk", label: "High Spam Risk", icon: ShieldAlert, tone: "text-critical" },
]

export const STAT_CARDS: StatCard[] = [...PRIMARY_STAT_CARDS, ...SECONDARY_STAT_CARDS]

/* ---------------------------------------------------------------------------
   SEO score, spam risk and relevance visuals. Bands mirror the backend config;
   colours resolve to design tokens so no component names a colour itself.
   --------------------------------------------------------------------------- */

const SEO_BANDS: { min: number; label: string; tone: string; bar: string }[] = [
  { min: 90, label: "Excellent", tone: "text-success", bar: "bg-success" },
  { min: 80, label: "Strong", tone: "text-success", bar: "bg-success" },
  { min: 70, label: "Good", tone: "text-info", bar: "bg-info" },
  { min: 60, label: "Review", tone: "text-caution", bar: "bg-caution" },
  { min: 0, label: "Weak", tone: "text-severe", bar: "bg-severe" },
]

export function seoBand(score: number | null) {
  if (score === null) {
    return { label: "Not scored", tone: "text-muted-foreground", bar: "bg-muted" }
  }
  return SEO_BANDS.find((band) => score >= band.min) ?? SEO_BANDS[SEO_BANDS.length - 1]
}

const SPAM_BADGE: Record<SpamLevel, string> = {
  Low: "border-success/25 bg-success/10 text-success",
  Moderate: "border-caution/25 bg-caution/10 text-caution",
  High: "border-severe/25 bg-severe/10 text-severe",
  "Very High": "border-transparent bg-destructive text-white",
}

export function spamBadgeClass(level: string | null): string {
  if (!level) return "border-border text-muted-foreground"
  return SPAM_BADGE[level as SpamLevel] ?? "border-border text-muted-foreground"
}

const RELEVANCE_BADGE: Record<RelevanceBand, string> = {
  High: "border-success/25 bg-success/10 text-success",
  Medium: "border-info/25 bg-info/10 text-info",
  Low: "border-border text-muted-foreground",
  None: "border-border text-muted-foreground",
}

export function relevanceBadgeClass(band: string | null): string {
  if (!band) return "border-border text-muted-foreground"
  return RELEVANCE_BADGE[band as RelevanceBand] ?? "border-border text-muted-foreground"
}

const STABILITY_TONE: Record<string, string> = {
  Stable: "text-success",
  "Some Changes": "text-caution",
  "High Topic Volatility": "text-severe",
}

export function stabilityTone(label: string | null): string {
  return (label && STABILITY_TONE[label]) || "text-muted-foreground"
}

const CONFIDENCE_TONE: Record<ScoreConfidence, string> = {
  Full: "text-muted-foreground",
  Partial: "text-caution",
  Limited: "text-severe",
}

export function confidenceTone(confidence: string | null): string {
  if (!confidence) return "text-muted-foreground"
  return CONFIDENCE_TONE[confidence as ScoreConfidence] ?? "text-muted-foreground"
}

const ANCHOR_KIND_LABEL: Record<string, string> = {
  branded: "Branded",
  generic: "Generic",
  exact_match: "Exact match",
  other: "Other",
}

export function anchorKindLabel(kind: string): string {
  return ANCHOR_KIND_LABEL[kind] ?? kind
}
