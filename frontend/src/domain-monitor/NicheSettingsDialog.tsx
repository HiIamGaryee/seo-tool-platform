import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/**
 * Target niches drive the topical relevance component of the SEO score.
 * With none selected that component is excluded rather than scored as zero.
 */
function NicheSettingsDialog({
  isOpen,
  onOpenChange,
  availableTopics,
  selected,
  onSave,
}: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  availableTopics: string[]
  selected: string[]
  onSave: (niches: string[]) => Promise<void>
}) {
  const [draft, setDraft] = useState<string[]>(selected)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (isOpen) setDraft(selected)
  }, [isOpen, selected])

  const toggle = (topic: string) => {
    setDraft((current) =>
      current.includes(topic)
        ? current.filter((item) => item !== topic)
        : [...current, topic],
    )
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      await onSave(draft)
      onOpenChange(false)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Target Niches</DialogTitle>
          <DialogDescription>
            Domains are scored for topical relevance against these niches. The
            keyword lists behind them live in the backend config.
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-72 grid-cols-2 gap-x-4 gap-y-2 overflow-y-auto">
          {availableTopics.map((topic) => (
            <label key={topic} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.includes(topic)}
                onCheckedChange={() => toggle(topic)}
              />
              <span>{topic}</span>
            </label>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="size-4 animate-spin" />}
            Save niches
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default NicheSettingsDialog
