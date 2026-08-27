import { useState } from "react"

import AppHeader from "@/components/layout/AppHeader"
import AppSidebar from "@/components/layout/AppSidebar"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { navItem, type PageId } from "@/lib/nav"
import { cn } from "@/lib/utils"

function AppShell({
  activePage,
  onNavigate,
  children,
}: {
  activePage: PageId
  onNavigate: (page: PageId) => void
  children: React.ReactNode
}) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false)

  const handleNavigate = (page: PageId) => {
    onNavigate(page)
    setIsMobileNavOpen(false)
  }

  return (
    <div className="flex min-h-svh w-full bg-background">
      <aside
        className={cn(
          "hidden shrink-0 border-r transition-[width] duration-200 md:block",
          isCollapsed ? "w-14" : "w-60",
        )}
      >
        <div className="sticky top-0 h-svh">
          <AppSidebar
            activePage={activePage}
            onNavigate={handleNavigate}
            isCollapsed={isCollapsed}
            onToggleCollapsed={() => setIsCollapsed((value) => !value)}
          />
        </div>
      </aside>

      <Sheet open={isMobileNavOpen} onOpenChange={setIsMobileNavOpen}>
        <SheetContent side="left" className="w-64 p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <AppSidebar
            activePage={activePage}
            onNavigate={handleNavigate}
            showCollapseControl={false}
          />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader
          item={navItem(activePage)}
          onOpenMobileNav={() => setIsMobileNavOpen(true)}
        />
        <main className="flex-1 px-4 py-5 md:px-8 md:py-7">{children}</main>
      </div>
    </div>
  )
}

export default AppShell
