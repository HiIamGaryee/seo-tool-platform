import { useSyncExternalStore } from "react"

export type ColorScheme = "light" | "dark"

const STORAGE_KEY = "seo-tool-color-scheme"
const listeners = new Set<() => void>()

function readInitial(): ColorScheme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === "light" || stored === "dark") return stored
  } catch {
    /* storage can throw in private mode; fall through to the system preference */
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

let current = readInitial()

function apply(scheme: ColorScheme) {
  document.documentElement.classList.toggle("dark", scheme === "dark")
  document.documentElement.style.colorScheme = scheme
}

apply(current)

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

export function setColorScheme(next: ColorScheme) {
  if (next === current) return
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* a failed write only costs persistence, not correctness */
  }
  apply(next)
  listeners.forEach((listener) => listener())
}

export function useColorScheme() {
  const scheme = useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  )

  return {
    scheme,
    setScheme: setColorScheme,
    toggle: () => setColorScheme(scheme === "dark" ? "light" : "dark"),
  }
}
