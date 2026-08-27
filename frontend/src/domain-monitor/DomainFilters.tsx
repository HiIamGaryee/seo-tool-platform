import { useState } from "react"
import { Check, ChevronDown, Search, SlidersHorizontal, Star, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

import {
  AGE_OPTIONS,
  DAYS_OPTIONS,
  PRIORITY_OPTIONS,
  REFERRING_OPTIONS,
  RELEVANCE_OPTIONS,
  SEO_SCORE_OPTIONS,
  SPAM_LEVEL_OPTIONS,
  STATUS_OPTIONS,
  hasActiveFilters,
  type DomainQuery,
  type DomainStatsResponse,
} from "./types"

/* Radix Select rejects an empty item value, so "any" stands in for "no filter". */
const ANY = "any"

function fromAny(value: string): string {
  return value === ANY ? "" : value
}

function toAny(value: string): string {
  return value === "" ? ANY : value
}

function DomainFilters({
  query,
  stats,
  searchInput,
  onSearchInput,
  onChange,
  onReset,
}: {
  query: DomainQuery
  stats: DomainStatsResponse | null
  searchInput: string
  onSearchInput: (value: string) => void
  onChange: (patch: Partial<DomainQuery>) => void
  onReset: () => void
}) {
  const [isTldOpen, setIsTldOpen] = useState(false)
  const tlds = stats?.tlds ?? []
  const activeExtraCount = [
    query.relevance,
    query.referring,
    query.age,
    query.priority,
    query.status,
    query.days,
  ].filter(Boolean).length

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={searchInput}
          onChange={(event) => onSearchInput(event.target.value)}
          placeholder="Search domain..."
          className="h-9 pl-8"
          aria-label="Search domain"
        />
      </div>

      <Popover open={isTldOpen} onOpenChange={setIsTldOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-9 justify-between gap-1.5 font-normal">
            {query.tld || "TLD"}
            <ChevronDown className="size-3.5 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-0">
          <Command>
            <CommandInput placeholder="Filter TLDs..." className="h-9" />
            <CommandList>
              <CommandEmpty>No TLD found.</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value="all-tlds"
                  onSelect={() => {
                    onChange({ tld: "", page: 1 })
                    setIsTldOpen(false)
                  }}
                >
                  <Check
                    className={cn("size-4", query.tld ? "opacity-0" : "opacity-100")}
                  />
                  All TLDs
                </CommandItem>
                {tlds.map((entry) => (
                  <CommandItem
                    key={entry.tld}
                    value={entry.tld}
                    onSelect={() => {
                      onChange({ tld: entry.tld, page: 1 })
                      setIsTldOpen(false)
                    }}
                  >
                    <Check
                      className={cn(
                        "size-4",
                        query.tld === entry.tld ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="flex-1">{entry.tld}</span>
                    <span className="tabular text-xs text-muted-foreground">
                      {entry.count}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <Select
        value={toAny(query.seoMin)}
        onValueChange={(value) => onChange({ seoMin: fromAny(value), page: 1 })}
      >
        <SelectTrigger size="sm" className="h-9 w-auto min-w-28 font-normal">
          <SelectValue placeholder="SEO score" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Any SEO score</SelectItem>
          {SEO_SCORE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={toAny(query.spamLevel)}
        onValueChange={(value) => onChange({ spamLevel: fromAny(value), page: 1 })}
      >
        <SelectTrigger size="sm" className="h-9 w-auto min-w-28 font-normal">
          <SelectValue placeholder="Spam risk" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Any spam risk</SelectItem>
          {SPAM_LEVEL_OPTIONS.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={toAny(query.topic)}
        onValueChange={(value) => onChange({ topic: fromAny(value), page: 1 })}
      >
        <SelectTrigger size="sm" className="h-9 w-auto min-w-24 font-normal">
          <SelectValue placeholder="Topic" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>All topics</SelectItem>
          {(stats?.topics ?? []).map((entry) => (
            <SelectItem key={entry.topic} value={entry.topic}>
              {entry.topic} ({entry.count})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-9 gap-1.5 font-normal">
            <SlidersHorizontal className="size-3.5" />
            More Filters
            {activeExtraCount > 0 && (
              <Badge variant="secondary" className="ml-0.5 h-5 px-1.5 text-[11px]">
                {activeExtraCount}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-3">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                Topical relevance
              </div>
              <Select
                value={toAny(query.relevance)}
                onValueChange={(value) => onChange({ relevance: fromAny(value), page: 1 })}
              >
                <SelectTrigger size="sm" className="w-full font-normal">
                  <SelectValue placeholder="Any relevance" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any relevance</SelectItem>
                  {RELEVANCE_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                Referring domains
              </div>
              <Select
                value={toAny(query.referring)}
                onValueChange={(value) => onChange({ referring: fromAny(value), page: 1 })}
              >
                <SelectTrigger size="sm" className="w-full font-normal">
                  <SelectValue placeholder="Any count" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any count</SelectItem>
                  {REFERRING_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">Domain age</div>
              <Select
                value={toAny(query.age)}
                onValueChange={(value) => onChange({ age: fromAny(value), page: 1 })}
              >
                <SelectTrigger size="sm" className="w-full font-normal">
                  <SelectValue placeholder="Any age" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any age</SelectItem>
                  {AGE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">Priority</div>
              <Select
                value={toAny(query.priority)}
                onValueChange={(value) => onChange({ priority: fromAny(value), page: 1 })}
              >
                <SelectTrigger size="sm" className="w-full font-normal">
                  <SelectValue placeholder="All priorities" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>All priorities</SelectItem>
                  {PRIORITY_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                Registry status
              </div>
              <Select
                value={toAny(query.status)}
                onValueChange={(value) => onChange({ status: fromAny(value), page: 1 })}
              >
                <SelectTrigger size="sm" className="w-full font-normal">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>All statuses</SelectItem>
                  {STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                Expiry window
              </div>
              <Select
                value={toAny(query.days)}
                onValueChange={(value) => onChange({ days: fromAny(value), page: 1 })}
              >
                <SelectTrigger size="sm" className="w-full font-normal">
                  <SelectValue placeholder="Any window" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any window</SelectItem>
                  {DAYS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                Rows per page
              </div>
              <Select
                value={String(query.limit)}
                onValueChange={(value) => onChange({ limit: Number(value), page: 1 })}
              >
                <SelectTrigger size="sm" className="w-full font-normal">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[20, 50, 100].map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size} per page
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <Button
        variant={query.watchlisted ? "secondary" : "outline"}
        size="sm"
        onClick={() => onChange({ watchlisted: !query.watchlisted, page: 1 })}
        className="h-9 gap-1.5 font-normal"
      >
        <Star className={cn("size-3.5", query.watchlisted && "fill-current")} />
        Watchlist
      </Button>

      {hasActiveFilters(query) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          className="h-9 gap-1.5 text-muted-foreground"
        >
          <X className="size-3.5" />
          Clear
        </Button>
      )}
    </div>
  )
}

export default DomainFilters
