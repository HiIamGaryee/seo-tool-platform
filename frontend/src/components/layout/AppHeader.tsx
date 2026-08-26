import { Menu, Moon, Sun } from "lucide-react"

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useColorScheme } from "@/hooks/use-color-scheme"
import type { NavItem } from "@/lib/nav"

function AppHeader({
  item,
  onOpenMobileNav,
}: {
  item: NavItem
  onOpenMobileNav: () => void
}) {
  const { scheme, toggle } = useColorScheme()
  const [section, page] = item.breadcrumb

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="size-8 md:hidden"
        onClick={onOpenMobileNav}
        aria-label="Open navigation"
      >
        <Menu className="size-4" />
      </Button>

      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem className="hidden sm:block">
            <span className="text-muted-foreground">{section}</span>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="hidden sm:block" />
          <BreadcrumbItem>
            <BreadcrumbPage className="font-medium">{page}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="ml-auto flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={toggle}
              aria-label={scheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {scheme === "dark" ? (
                <Sun className="size-4" />
              ) : (
                <Moon className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {scheme === "dark" ? "Light mode" : "Dark mode"}
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}

export default AppHeader
