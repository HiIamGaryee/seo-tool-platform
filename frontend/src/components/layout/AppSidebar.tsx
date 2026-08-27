import { PanelLeftClose, PanelLeftOpen } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { NAV_SECTIONS, type PageId } from "@/lib/nav"
import { cn } from "@/lib/utils"

type AppSidebarProps = {
  activePage: PageId
  onNavigate: (page: PageId) => void
  isCollapsed?: boolean
  onToggleCollapsed?: () => void
  showCollapseControl?: boolean
}

function AppSidebar({
  activePage,
  onNavigate,
  isCollapsed = false,
  onToggleCollapsed,
  showCollapseControl = true,
}: AppSidebarProps) {
  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div
        className={cn(
          "flex h-14 shrink-0 items-center gap-2 px-3",
          isCollapsed && "justify-center px-0",
        )}
      >
        {/* Pixel-art brand mark: transparent PNG, so no plate behind it, and
            pixelated rendering keeps the edges crisp when scaled down. */}
        <img
          src="/logo.png"
          alt="PAC SEO Tool"
          width={32}
          height={32}
          className="size-8 shrink-0 object-contain [image-rendering:pixelated]"
        />
        {!isCollapsed && (
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold leading-tight">
              PAC SEO Tool
            </div>
            <div className="truncate text-xs text-muted-foreground">
              Domain intelligence
            </div>
          </div>
        )}
      </div>

      <Separator className="bg-sidebar-border" />

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {NAV_SECTIONS.map((section, index) => (
          <div key={section.heading ?? `section-${index}`} className="mb-4 last:mb-0">
            {section.heading && !isCollapsed && (
              <div className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {section.heading}
              </div>
            )}
            {section.heading && isCollapsed && index > 0 && (
              <Separator className="mx-auto mb-2 w-6 bg-sidebar-border" />
            )}

            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = activePage === item.id
                const button = (
                  <button
                    type="button"
                    onClick={() => onNavigate(item.id)}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "group relative flex w-full items-center gap-2.5 rounded-md py-2 text-sm transition-colors",
                      isCollapsed ? "justify-center px-0" : "px-2.5",
                      isActive
                        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                        : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                    )}
                  >
                    {/* Slim left indicator instead of a full-width capsule. */}
                    <span
                      aria-hidden
                      className={cn(
                        "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-primary transition-opacity",
                        isActive ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <item.icon
                      className={cn(
                        "size-4 shrink-0",
                        isActive ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                    {!isCollapsed && <span className="truncate">{item.label}</span>}
                  </button>
                )

                return (
                  <li key={item.id}>
                    {isCollapsed ? (
                      <Tooltip>
                        <TooltipTrigger asChild>{button}</TooltipTrigger>
                        <TooltipContent side="right">{item.label}</TooltipContent>
                      </Tooltip>
                    ) : (
                      button
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      {showCollapseControl && onToggleCollapsed && (
        <>
          <Separator className="bg-sidebar-border" />
          <div className={cn("p-2", isCollapsed && "flex justify-center")}>
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggleCollapsed}
              className={cn(
                "text-muted-foreground",
                isCollapsed ? "size-8 p-0" : "w-full justify-start gap-2.5 px-2.5",
              )}
              aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {isCollapsed ? (
                <PanelLeftOpen className="size-4" />
              ) : (
                <>
                  <PanelLeftClose className="size-4" />
                  <span>Collapse</span>
                </>
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

export default AppSidebar
