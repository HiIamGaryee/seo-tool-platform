import {
  Home,
  Image,
  Download,
  Radar,
  type LucideIcon,
} from "lucide-react"

export type PageId = "home" | "download" | "imgextract" | "domains"

export type NavItem = {
  id: PageId
  label: string
  icon: LucideIcon
  breadcrumb: [string, string]
}

export type NavSection = {
  heading: string | null
  items: NavItem[]
}

/* Mirrors the pages that actually exist. No placeholder routes. */
export const NAV_SECTIONS: NavSection[] = [
  {
    heading: null,
    items: [
      {
        id: "home",
        label: "Home",
        icon: Home,
        breadcrumb: ["Analyze", "Sitemap Analyzer"],
      },
    ],
  },
  {
    heading: "Tools",
    items: [
      {
        id: "download",
        label: "Download",
        icon: Download,
        breadcrumb: ["Tools", "Sitemap Download"],
      },
      {
        id: "imgextract",
        label: "Image Extractor",
        icon: Image,
        breadcrumb: ["Tools", "Image Extractor"],
      },
      {
        id: "domains",
        label: "Domain Radar",
        icon: Radar,
        breadcrumb: ["Tools", "SEO Domain Radar"],
      },
    ],
  },
]

export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items)

export function navItem(id: PageId): NavItem {
  return NAV_ITEMS.find((item) => item.id === id) ?? NAV_ITEMS[0]
}
