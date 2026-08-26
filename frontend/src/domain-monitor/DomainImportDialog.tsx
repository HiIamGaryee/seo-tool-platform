import { useRef, useState } from "react"
import { FileUp, Loader2, Upload } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

import { errorMessage, importDomainText, importDomains } from "./api"
import type { ImportResult } from "./types"

const RESULT_FIELDS = [
  { key: "imported", label: "Imported", tone: "text-success" },
  { key: "duplicates", label: "Duplicates", tone: "text-muted-foreground" },
  { key: "invalid", label: "Invalid", tone: "text-severe" },
] as const

function DomainImportDialog({
  isOpen,
  onOpenChange,
  onImported,
}: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onImported: (result: ImportResult) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [pasted, setPasted] = useState("")
  const [isDragging, setIsDragging] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setFile(null)
    setPasted("")
    setResult(null)
    setError(null)
    if (inputRef.current) inputRef.current.value = ""
  }

  const handleOpenChange = (open: boolean) => {
    if (!open) reset()
    onOpenChange(open)
  }

  const canImport = Boolean(file) || pasted.trim().length > 0

  const handleImport = async () => {
    if (!canImport) return
    setIsImporting(true)
    setError(null)
    setResult(null)
    try {
      const response = file
        ? await importDomains(file)
        : await importDomainText(pasted)
      setResult(response)
      onImported(response)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setIsImporting(false)
    }
  }

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault()
    setIsDragging(false)
    const dropped = event.dataTransfer.files?.[0]
    if (dropped) {
      setFile(dropped)
      setResult(null)
      setError(null)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import Domains</DialogTitle>
          <DialogDescription>
            One domain per line. Invalid names are rejected and duplicates skipped.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div
            onDragOver={(event) => {
              event.preventDefault()
              setIsDragging(true)
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-4 py-6 text-center transition-colors",
              isDragging ? "border-primary bg-primary/5" : "hover:bg-accent/50",
            )}
          >
            <FileUp className="size-5 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">
              {file ? file.name : "Drop a TXT or CSV file"}
            </p>
            <p className="text-xs text-muted-foreground">
              {file ? `${(file.size / 1024).toFixed(1)} KB` : "or click to browse"}
            </p>
            <input
              ref={inputRef}
              type="file"
              accept=".txt,.csv,text/plain,text/csv"
              className="hidden"
              onChange={(event) => {
                setFile(event.target.files?.[0] || null)
                setResult(null)
                setError(null)
              }}
            />
          </div>

          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-xs text-muted-foreground">or paste</span>
            <Separator className="flex-1" />
          </div>

          <Textarea
            value={pasted}
            onChange={(event) => {
              setPasted(event.target.value)
              setResult(null)
              setError(null)
            }}
            disabled={Boolean(file)}
            rows={4}
            placeholder={"example.com\nexample.net\nexample.org"}
            className="resize-none font-mono text-xs"
          />

          {result && (
            <dl className="grid grid-cols-3 gap-2">
              {RESULT_FIELDS.map((field) => (
                <div key={field.key} className="rounded-md bg-muted px-3 py-2">
                  <dt className="text-xs text-muted-foreground">{field.label}</dt>
                  <dd className={cn("tabular text-lg font-semibold", field.tone)}>
                    {result[field.key].toLocaleString()}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {result && result.invalid_samples.length > 0 && (
            <p className="break-all text-xs text-muted-foreground">
              Rejected: {result.invalid_samples.join(", ")}
            </p>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          {result ? (
            <>
              <Button variant="outline" onClick={reset}>
                Import another
              </Button>
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleImport} disabled={!canImport || isImporting}>
                {isImporting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Upload className="size-4" />
                )}
                Import
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default DomainImportDialog
