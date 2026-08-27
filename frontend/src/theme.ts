export type Theme = {
  id: number;
  name: string;
  background: string;
  cardBackground: string;
  primaryText: string;
  secondaryText: string;
  primaryButtonGradient: string;
  primaryButtonDisabled: string;
  subtleAccent: string;
};

export const THEMES: Theme[] = [
  {
    id: 0,
    name: "Lavender Glow",
    background:
      "linear-gradient(135deg, #f4f4fb 0%, #e1dcff 40%, #8a81db 100%)",
    cardBackground: "rgba(255, 255, 255, 0.9)",
    primaryText: "#111827",
    secondaryText: "#374151",
    primaryButtonGradient: "linear-gradient(135deg, #f97316, #ec4899, #6366f1)",
    primaryButtonDisabled: "#9CA3AF",
    subtleAccent: "rgba(79, 70, 229, 0.06)",
  },
  {
    id: 1,
    name: "Deep Night",
    background:
      "radial-gradient(circle at top, #4f46e5 0%, #111827 55%, #020617 100%)",
    cardBackground: "rgba(15, 23, 42, 0.95)",
    primaryText: "#f9fafb",
    secondaryText: "#e5e7eb",
    primaryButtonGradient: "linear-gradient(135deg, #22c55e, #14b8a6, #3b82f6)",
    primaryButtonDisabled: "#4b5563",
    subtleAccent: "rgba(148, 163, 184, 0.18)",
  },
  {
    id: 2,
    name: "Aqua Sunset",
    background:
      "linear-gradient(135deg, #fef3c7 0%, #bae6fd 35%, #38bdf8 60%, #f97316 100%)",
    cardBackground: "rgba(255, 255, 255, 0.93)",
    primaryText: "#111827",
    secondaryText: "#374151",
    primaryButtonDisabled: "#9CA3AF",
    primaryButtonGradient: "linear-gradient(135deg, #0ea5e9, #6366f1)",
    subtleAccent: "rgba(56, 189, 248, 0.12)",
  },
  {
    id: 3,
    name: "Warm Sand",
    background:
      "linear-gradient(135deg, #fefce8 0%, #fed7aa 35%, #f97316 75%, #ea580c 100%)",
    cardBackground: "rgba(255, 255, 255, 0.95)",
    primaryText: "#111827",
    secondaryText: "#374151",
    primaryButtonDisabled: "#9CA3AF",
    primaryButtonGradient: "linear-gradient(135deg, #f97316, #ec4899)",
    subtleAccent: "rgba(234, 88, 12, 0.08)",
  },
];
