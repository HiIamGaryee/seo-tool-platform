import { useState } from "react";
import axios from "axios";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import "./index.css";

function Icon({
  name,
  size = 18,
}: {
  name: "home" | "download" | "book" | "close" | "back";
  size?: number;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
  } as const;

  switch (name) {
    case "home":
      return (
        <svg {...common} aria-hidden>
          <path
            d="M3 10.8 12 3l9 7.8V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V10.8Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "download":
      return (
        <svg {...common} aria-hidden>
          <path
            d="M12 3v10m0 0 4-4m-4 4-4-4"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "book":
      return (
        <svg {...common} aria-hidden>
          <path
            d="M12 6c-2-1.4-5-2-8-2v14c3 0 6 .6 8 2"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path
            d="M12 6c2-1.4 5-2 8-2v14c-3 0-6 .6-8 2"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path
            d="M12 6v16"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      );
    case "close":
      return (
        <svg {...common} aria-hidden>
          <path
            d="M6 6l12 12M18 6 6 18"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      );
    case "back":
      return (
        <svg {...common} aria-hidden>
          <path
            d="M14.5 6 8.5 12l6 6"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    default:
      return null;
  }
}

type SeoRow = {
  url: string;
  title: string;
  description: string;
  keywords?: string;
  canonical: string;
  robots: string;
  language: string;
  jsonld: string;
  domElements: number;
  styleTags: number;
  error?: string;
  og_title?: string;
  og_description?: string;
  og_image?: string;
  og_type?: string;
};

type Theme = {
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

const THEMES: Theme[] = [
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

const MAX_URLS = 100;
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
const REQUEST_TIMEOUT_MS = 10000;

function parseSitemapXml(xmlText: string): string[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const locNodes = Array.from(doc.getElementsByTagName("loc"));
  const urls = locNodes
    .map((n) => n.textContent?.trim())
    .filter((u): u is string => !!u);
  return urls.slice(0, MAX_URLS);
}

function filenameFromUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts.length ? decodeURIComponent(parts[parts.length - 1]) : "index";
    return `${last}.html`;
  } catch {
    return "page.html";
  }
}

function zipNameFromUrls(urls: string[]): string {
  const raw = urls[0] || "";
  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    const labels = hostname.split(".").filter(Boolean);
    if (labels.length === 0) return "html-pages.zip";

    // strip common prefixes
    const prefixes = new Set(["www", "m"]);
    const normalized = labels.filter((l, idx) => !(idx === 0 && prefixes.has(l)));

    const twoPartTlds = new Set([
      "co.uk",
      "com.au",
      "com.sg",
      "com.my",
      "com.hk",
      "com.tw",
      "co.jp",
      "co.nz",
      "co.kr",
    ]);

    const tail2 = normalized.slice(-2).join(".");
    const tail3 = normalized.slice(-3).join(".");

    // If it looks like a two-part TLD, pick the label before it.
    let domain = "";
    if (normalized.length >= 3 && twoPartTlds.has(tail2)) {
      domain = normalized[normalized.length - 3];
    } else if (normalized.length >= 4 && twoPartTlds.has(tail3.split(".").slice(-2).join("."))) {
      domain = normalized[normalized.length - 3];
    } else if (normalized.length >= 2) {
      domain = normalized[normalized.length - 2]; // abc.com -> abc
    } else {
      domain = normalized[0];
    }

    const safe = domain.replace(/[^a-z0-9-]/gi, "_");
    return `${safe || "html-pages"}.zip`;
  } catch {
    return "html-pages.zip";
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

function exportToExcel(rows: SeoRow[]) {
  if (!rows.length) return;

  const plainRows = rows.map((r) => ({
    URL: r.url,
    Title: r.title,
    Description: r.description,
    Keywords: r.keywords || "",
    Canonical: r.canonical,
    "Robots Tag": r.robots,
    Language: r.language,
    "JSON-LD": r.jsonld,
    "DOM Elements Count": r.domElements,
    "Style Tag Count": r.styleTags,
    Error: r.error || "",
  }));

  const worksheet = XLSX.utils.json_to_sheet(plainRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "SEO Analysis");

  const wbout = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  const blob = new Blob([wbout], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "seo-analysis-report.xlsx";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<SeoRow[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<number>(0);
  const [message, setMessage] = useState<string | null>(null);
  const [themeIndex, setThemeIndex] = useState(0);
  const [showAllOg, setShowAllOg] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [activePage, setActivePage] = useState<"home" | "download">("home");
  const [downloadFile, setDownloadFile] = useState<File | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [isSitemapPreviewOpen, setIsSitemapPreviewOpen] = useState(false);
  const [sitemapPreviewText, setSitemapPreviewText] = useState<string>("");
  const [sitemapPreviewName, setSitemapPreviewName] = useState<string>("sitemap.xml");

  const theme = THEMES[themeIndex];

  const handleThemeChange = () => {
    setThemeIndex((prev) => (prev + 1) % THEMES.length);
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const f = event.target.files?.[0] || null;
    setFile(f);
    setRows([]);
    setProgress(0);
    setMessage(null);
  };

  const handleRun = async () => {
    if (!file) {
      setMessage("Please upload a sitemap.xml file first.");
      return;
    }

    setIsRunning(true);
    setRows([]);
    setProgress(0);
    setMessage(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await axios.post<{ rows: SeoRow[] }>(
        `${API_BASE_URL}/analyze-sitemap`,
        formData,
        {
          headers: { "Content-Type": "multipart/form-data" },
          timeout: REQUEST_TIMEOUT_MS * MAX_URLS,
        },
      );

      const results = response.data.rows || [];
      setRows(results);
      setProgress(100);
      setMessage(`Analysis completed for ${results.length} URLs.`);
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
      setMessage(`Failed to analyze sitemap: ${message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const handleDownload = () => {
    exportToExcel(rows);
  };

  const openSitemapPreview = async (f: File | null) => {
    if (!f) return;
    const text = await f.text();
    setSitemapPreviewText(text);
    setSitemapPreviewName(f.name || "sitemap.xml");
    setIsSitemapPreviewOpen(true);
  };

  const handleDownloadFileChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const f = event.target.files?.[0] || null;
    setDownloadFile(f);
    setDownloadProgress(0);
    setDownloadMessage(null);
  };

  const downloadAllHtmlZip = async () => {
    if (!downloadFile) {
      setDownloadMessage("Please upload a sitemap.xml file first.");
      return;
    }

    setIsDownloading(true);
    setDownloadProgress(0);
    setDownloadMessage(null);

    try {
      const xml = await downloadFile.text();
      const urls = parseSitemapXml(xml);
      if (!urls.length) {
        setDownloadMessage("No URLs found in sitemap.");
        return;
      }

      const zipName = zipNameFromUrls(urls);

      const zip = new JSZip();
      const usedNames = new Map<string, number>();

      for (let i = 0; i < urls.length; i += 1) {
        const url = urls[i];
        const baseName = filenameFromUrl(url);
        const count = usedNames.get(baseName) ?? 0;
        usedNames.set(baseName, count + 1);
        const name =
          count === 0 ? baseName : baseName.replace(/\.html$/i, `-${count + 1}.html`);

        const htmlRes = await axios.get<string>(`${API_BASE_URL}/fetch-html`, {
          params: { url },
          responseType: "text",
          timeout: 15000,
        });
        zip.file(name, htmlRes.data || "");
        setDownloadProgress(Math.round(((i + 1) / urls.length) * 100));
      }

      const blob = await zip.generateAsync({ type: "blob" });
      downloadBlob(blob, zipName);
      setDownloadMessage(`Downloaded ${urls.length} pages as ${zipName}`);
    } catch (e: unknown) {
      const msg =
        e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
      setDownloadMessage(`Download failed: ${msg}`);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundImage: theme.background,
        padding: "1rem",
      }}
    >
      {/* Sitemap preview modal */}
      <div
        onClick={() => setIsSitemapPreviewOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(0,0,0,0.4)",
          opacity: isSitemapPreviewOpen ? 1 : 0,
          pointerEvents: isSitemapPreviewOpen ? "auto" : "none",
          transition: "opacity 180ms ease-out",
          zIndex: 60,
        }}
      />
      <div
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: isSitemapPreviewOpen
            ? "translate(-50%, -50%) scale(1)"
            : "translate(-50%, -50%) scale(0.98)",
          width: "min(920px, calc(100vw - 2rem))",
          maxHeight: "min(80vh, 720px)",
          backgroundColor:
            theme.name === "Deep Night" ? "rgba(15, 23, 42, 0.98)" : "#ffffff",
          color: theme.primaryText,
          borderRadius: "0.9rem",
          border:
            theme.name === "Deep Night"
              ? "1px solid rgba(51,65,85,0.7)"
              : "1px solid rgba(229,231,235,0.9)",
          boxShadow: "0 30px 90px rgba(0,0,0,0.35)",
          opacity: isSitemapPreviewOpen ? 1 : 0,
          pointerEvents: isSitemapPreviewOpen ? "auto" : "none",
          transition: "opacity 180ms ease-out, transform 180ms ease-out",
          zIndex: 70,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
        role="dialog"
        aria-modal="true"
        aria-hidden={!isSitemapPreviewOpen}
      >
        <div
          style={{
            padding: "0.85rem 1rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom:
              theme.name === "Deep Night"
                ? "1px solid rgba(51,65,85,0.7)"
                : "1px solid rgba(229,231,235,0.9)",
          }}
        >
          <div style={{ fontWeight: 700 }}>Sitemap preview · {sitemapPreviewName}</div>
          <button
            type="button"
            onClick={() => setIsSitemapPreviewOpen(false)}
            style={{
              border: "none",
              background: "transparent",
              color: theme.primaryText,
              cursor: "pointer",
              fontSize: "1.2rem",
              lineHeight: 1,
            }}
            aria-label="Close preview"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: "0.9rem 1rem",
            overflow: "auto",
            fontSize: "0.75rem",
            lineHeight: 1.45,
            color: theme.name === "Deep Night" ? "#e5e7eb" : "#111827",
            backgroundColor:
              theme.name === "Deep Night" ? "rgba(2,6,23,0.55)" : "rgba(249,250,251,0.95)",
          }}
        >
          {sitemapPreviewText}
        </pre>
      </div>

      {/* Right-side slide-out menu */}
      <div
        onClick={() => setIsMenuOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(0,0,0,0.35)",
          opacity: isMenuOpen ? 1 : 0,
          pointerEvents: isMenuOpen ? "auto" : "none",
          transition: "opacity 180ms ease-out",
          zIndex: 40,
        }}
      />
      <aside
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          height: "100vh",
          width: "320px",
          maxWidth: "85vw",
          backgroundColor:
            theme.name === "Deep Night" ? "rgba(15, 23, 42, 0.98)" : "#ffffff",
          color: theme.primaryText,
          borderLeft:
            theme.name === "Deep Night"
              ? "1px solid rgba(51,65,85,0.7)"
              : "1px solid rgba(229,231,235,0.9)",
          boxShadow: "0 30px 80px rgba(0,0,0,0.35)",
          transform: isMenuOpen ? "translateX(0)" : "translateX(105%)",
          transition: "transform 220ms ease-out",
          zIndex: 50,
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
        }}
        aria-hidden={!isMenuOpen}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontWeight: 700 }}>Menu</div>
          <button
            type="button"
            onClick={() => setIsMenuOpen(false)}
            style={{
              border: "none",
              background: "transparent",
              color: theme.primaryText,
              cursor: "pointer",
              fontSize: "1.2rem",
              lineHeight: 1,
            }}
            aria-label="Close menu"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <nav style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <button
            type="button"
            onClick={() => {
              setActivePage("home");
              setIsMenuOpen(false);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.6rem",
              width: "100%",
              padding: "0.65rem 0.75rem",
              borderRadius: "0.75rem",
              border:
                activePage === "home"
                  ? "1px solid rgba(99,102,241,0.55)"
                  : "1px solid rgba(229,231,235,0.9)",
              backgroundColor:
                activePage === "home"
                  ? "rgba(99,102,241,0.12)"
                  : "rgba(148,163,184,0.06)",
              color: theme.primaryText,
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span
              aria-hidden
              style={{
                width: "1.25rem",
                display: "grid",
                placeItems: "center",
              }}
            >
              <Icon name="home" size={18} />
            </span>
            <span>Home</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setActivePage("download");
              setIsMenuOpen(false);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.6rem",
              width: "100%",
              padding: "0.65rem 0.75rem",
              borderRadius: "0.75rem",
              border:
                activePage === "download"
                  ? "1px solid rgba(236,72,153,0.55)"
                  : "1px solid rgba(229,231,235,0.9)",
              backgroundColor:
                activePage === "download"
                  ? "rgba(236,72,153,0.12)"
                  : "rgba(148,163,184,0.06)",
              color: theme.primaryText,
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span
              aria-hidden
              style={{
                width: "1.25rem",
                display: "grid",
                placeItems: "center",
              }}
            >
              <Icon name="download" size={18} />
            </span>
            <span>Download</span>
          </button>
        </nav>

        <div style={{ marginTop: "auto", fontSize: "0.75rem", color: theme.secondaryText }}>
          Tip: Use “Download” after you run an analysis.
        </div>
      </aside>

      <div
        style={{
          maxWidth: "960px",
          width: "100%",
          backgroundColor: theme.cardBackground,
          borderRadius: "0.75rem",
          boxShadow: "0 24px 60px rgba(15,23,42,0.18)",
          padding: "1.75rem 2rem",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "0.75rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <button
              type="button"
              onClick={() => setIsMenuOpen(true)}
              style={{
                width: "2.1rem",
                height: "2.1rem",
                marginLeft: "0.2rem",
                borderRadius: "999px",
                border:
                  theme.name === "Deep Night"
                    ? "1px solid rgba(51,65,85,0.7)"
                    : "1px solid rgba(229,231,235,0.9)",
                backgroundColor:
                  theme.name === "Deep Night"
                    ? "rgba(15,23,42,0.7)"
                    : "rgba(255,255,255,0.9)",
                color: theme.primaryText,
                cursor: "pointer",
                display: "grid",
                placeItems: "center",
                padding: 0,
              }}
              aria-label="Open menu"
            >
              <span
                aria-hidden
                style={{
                  display: "grid",
                  gap: "3px",
                  lineHeight: 0,
                }}
              >
                <span
                  style={{
                    display: "block",
                    width: "14px",
                    height: "2px",
                    backgroundColor: theme.primaryText,
                    borderRadius: "999px",
                    opacity: 0.9,
                  }}
                />
                <span
                  style={{
                    display: "block",
                    width: "14px",
                    height: "2px",
                    backgroundColor: theme.primaryText,
                    borderRadius: "999px",
                    opacity: 0.9,
                  }}
                />
                <span
                  style={{
                    display: "block",
                    width: "14px",
                    height: "2px",
                    backgroundColor: theme.primaryText,
                    borderRadius: "999px",
                    opacity: 0.9,
                  }}
                />
              </span>
            </button>
            <h1
              style={{
                fontSize: "1.5rem",
                fontWeight: 600,
                marginBottom: 0,
                color: theme.primaryText,
                letterSpacing: "0.02em",
              }}
            >
              SEO Sitemap Analyzer
            </h1>
            <button
              type="button"
              onClick={() => setShowInfo((v) => !v)}
              style={{
                width: "1.4rem",
                height: "1.4rem",
                borderRadius: "999px",
                border: "1px solid rgba(148,163,184,0.6)",
                backgroundColor: "rgba(255,255,255,0.8)",
                color: theme.primaryText,
                fontSize: "0.8rem",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
              }}
            >
              i
            </button>
          </div>

          <button
            type="button"
            onClick={handleThemeChange}
            style={{
              background: "rgba(255,255,255,0.25)",
              color: theme.primaryText,
              padding: "0.35rem 0.75rem",
              borderRadius: "999px",
              border: "1px solid rgba(255,255,255,0.4)",
              cursor: "pointer",
              fontSize: "0.75rem",
              fontWeight: 500,
              backdropFilter: "blur(6px)",
            }}
          >
            Theme: {theme.name}
          </button>
        </div>

        {showInfo && (
          <div
            style={{
              marginBottom: "1rem",
              fontSize: "0.75rem",
              color: theme.secondaryText,
              backgroundColor:
                theme.name === "Deep Night"
                  ? "rgba(15,23,42,0.9)"
                  : "rgba(249,250,251,0.9)",
              borderRadius: "0.5rem",
              padding: "0.75rem 0.9rem",
              border:
                theme.name === "Deep Night"
                  ? "1px solid rgba(55,65,81,0.9)"
                  : "1px solid rgba(229,231,235,0.9)",
            }}
          >
            <div style={{ marginBottom: "0.25rem", fontWeight: 600 }}>
              How to use
            </div>
            <ol style={{ margin: 0, paddingLeft: "1.1rem", textAlign: "left" }}>
              <li>
                Go to{" "}
                <a
                  href="https://www.xml-sitemaps.com/"
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "#2563eb" }}
                >
                  xml-sitemaps.com
                </a>{" "}
                and generate a sitemap for the site you want to check.
              </li>
              <li>Download the `sitemap.xml` file from there.</li>
              <li>Upload that file here, click “Run SEO Analysis”.</li>
              <li>
                Review important fields: Title, Description, Keywords, Canonical
                URL, Robots tag, JSON-LD, and Open Graph.
              </li>
            </ol>
          </div>
        )}

        {isRunning && (
          <div
            style={{
              marginBottom: "1rem",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "0.75rem",
            }}
          >
            <div id="ghost">
              <div id="red">
                <div id="pupil" />
                <div id="pupil1" />
                <div id="eye" />
                <div id="eye1" />
                <div id="top0" />
                <div id="top1" />
                <div id="top2" />
                <div id="top3" />
                <div id="top4" />
                <div id="st0" />
                <div id="st1" />
                <div id="st2" />
                <div id="st3" />
                <div id="st4" />
                <div id="st5" />
                <div id="an1" />
                <div id="an2" />
                <div id="an3" />
                <div id="an4" />
                <div id="an5" />
                <div id="an6" />
                <div id="an7" />
                <div id="an8" />
                <div id="an9" />
                <div id="an10" />
                <div id="an11" />
                <div id="an12" />
                <div id="an13" />
                <div id="an14" />
                <div id="an15" />
                <div id="an16" />
                <div id="an17" />
                <div id="an18" />
              </div>
              <div id="shadow" />
            </div>

            <div style={{ width: "100%", maxWidth: "360px" }}>
              <div
                style={{
                  height: "6px",
                  borderRadius: "999px",
                  backgroundColor: "rgba(148,163,184,0.3)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${Math.max(5, progress)}%`,
                    background:
                      "linear-gradient(90deg, #22c55e, #0ea5e9, #6366f1)",
                    transition: "width 0.3s ease-out",
                  }}
                />
              </div>
              <div
                style={{
                  marginTop: "0.25rem",
                  fontSize: "0.75rem",
                  textAlign: "center",
                  color: theme.secondaryText,
                }}
              >
                {progress}% completed
              </div>
            </div>
          </div>
        )}

        {activePage === "download" ? (
          <div style={{ marginBottom: "0.5rem" }}>
            <div
              style={{
                textAlign: "left",
                color: theme.primaryText,
                fontWeight: 700,
                marginBottom: "0.25rem",
              }}
            >
              Download
            </div>
            <div
              style={{
                textAlign: "left",
                color: theme.secondaryText,
                fontSize: "0.85rem",
                marginBottom: "1rem",
              }}
            >
              Upload a sitemap and download all pages as HTML (ZIP).
            </div>

            <div style={{ marginBottom: "0.75rem", textAlign: "left" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "0.875rem",
                  fontWeight: 500,
                  color: theme.secondaryText,
                  marginBottom: "0.25rem",
                }}
              >
                Upload sitemap.xml
              </label>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  padding: "0.5rem 0.75rem",
                  borderRadius: "999px",
                  backgroundColor: theme.subtleAccent,
                }}
              >
                <input type="file" accept=".xml" onChange={handleDownloadFileChange} />
                {downloadFile && (
                  <button
                    type="button"
                    onClick={() => openSitemapPreview(downloadFile)}
                    style={{
                      width: "2rem",
                      height: "2rem",
                      borderRadius: "999px",
                      border: "1px solid rgba(148,163,184,0.35)",
                      backgroundColor: "rgba(255,255,255,0.7)",
                      cursor: "pointer",
                      display: "grid",
                      placeItems: "center",
                      color: theme.primaryText,
                    }}
                    aria-label="Preview sitemap"
                    title="Preview sitemap"
                  >
                    <Icon name="book" size={18} />
                  </button>
                )}
              </div>
            </div>

            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                justifyContent: "flex-start",
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                onClick={() => setActivePage("home")}
                style={{
                  background: "rgba(148,163,184,0.18)",
                  color: theme.primaryText,
                  padding: "0.5rem 1rem",
                  borderRadius: "999px",
                  border: "1px solid rgba(148,163,184,0.35)",
                  cursor: "pointer",
                  fontSize: "0.875rem",
                  fontWeight: 500,
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                  <Icon name="back" size={18} /> Back to Home
                </span>
              </button>

              <button
                type="button"
                onClick={downloadAllHtmlZip}
                disabled={!downloadFile || isDownloading}
                style={{
                  background: downloadFile && !isDownloading
                    ? "linear-gradient(135deg, #22c55e, #16a34a)"
                    : theme.primaryButtonDisabled,
                  color: "#ffffff",
                  padding: "0.5rem 1rem",
                  borderRadius: "999px",
                  border: "none",
                  cursor: downloadFile && !isDownloading ? "pointer" : "not-allowed",
                  fontSize: "0.875rem",
                  fontWeight: 500,
                }}
              >
                {isDownloading ? `Downloading… ${downloadProgress}%` : "Download all HTML (ZIP)"}
              </button>
            </div>

            {isDownloading && (
              <div style={{ marginTop: "0.75rem", maxWidth: "420px" }}>
                <div
                  style={{
                    height: "6px",
                    borderRadius: "999px",
                    backgroundColor: "rgba(148,163,184,0.3)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${Math.max(5, downloadProgress)}%`,
                      background: "linear-gradient(90deg, #22c55e, #0ea5e9, #6366f1)",
                      transition: "width 0.3s ease-out",
                    }}
                  />
                </div>
              </div>
            )}

            {downloadMessage && (
              <div style={{ marginTop: "0.75rem", textAlign: "left", fontSize: "0.85rem", color: theme.secondaryText }}>
                {downloadMessage}
              </div>
            )}
          </div>
        ) : (
          <div style={{ marginBottom: "1rem" }}>
          <label
            style={{
              display: "block",
              fontSize: "0.875rem",
              fontWeight: 500,
              color: theme.secondaryText,
              marginBottom: "0.25rem",
            }}
          >
            Upload sitemap.xml
          </label>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.5rem 0.75rem",
              borderRadius: "999px",
              backgroundColor: theme.subtleAccent,
            }}
          >
            <input type="file" accept=".xml" onChange={handleFileChange} />
            {file && (
              <button
                type="button"
                onClick={() => openSitemapPreview(file)}
                style={{
                  width: "2rem",
                  height: "2rem",
                  borderRadius: "999px",
                  border: "1px solid rgba(148,163,184,0.35)",
                  backgroundColor: "rgba(255,255,255,0.7)",
                  cursor: "pointer",
                  display: "grid",
                  placeItems: "center",
                  color: theme.primaryText,
                }}
                aria-label="Preview sitemap"
                title="Preview sitemap"
              >
                <Icon name="book" size={18} />
              </button>
            )}
          </div>
        </div>
        )}

        {activePage === "home" && (
          <div
            style={{
              marginBottom: "1rem",
              display: "flex",
              gap: "0.75rem",
              alignItems: "center",
            }}
          >
            <button
              type="button"
              onClick={handleRun}
              disabled={!file || isRunning}
              style={{
                background:
                  !file || isRunning
                    ? theme.primaryButtonDisabled
                    : theme.primaryButtonGradient,
                color: "#ffffff",
                padding: "0.5rem 1rem",
                borderRadius: "999px",
                border: "none",
                cursor: !file || isRunning ? "not-allowed" : "pointer",
                fontSize: "0.875rem",
                fontWeight: 500,
                boxShadow: "0 12px 30px rgba(15,23,42,0.25)",
              }}
            >
              {isRunning ? "Running…" : "Run SEO Analysis"}
            </button>

            {isRunning && (
              <div style={{ fontSize: "0.875rem", color: theme.secondaryText }}>
                Analyzing… {progress}%
              </div>
            )}
          </div>
        )}

        {activePage === "home" && message && (
          <p
            style={{
              fontSize: "0.875rem",
              marginBottom: "1rem",
              color: theme.secondaryText,
            }}
          >
            {message}
          </p>
        )}

        {activePage === "home" && rows.length > 0 && (
          <>
            <div
              style={{
                marginBottom: "0.75rem",
                display: "flex",
                gap: "0.5rem",
              }}
            >
              <button
                type="button"
                onClick={handleDownload}
                style={{
                  background: "linear-gradient(135deg, #22c55e, #16a34a)",
                  color: "#ffffff",
                  padding: "0.5rem 1rem",
                  borderRadius: "999px",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "0.875rem",
                  fontWeight: 500,
                }}
              >
                Download Excel
              </button>
              <button
                type="button"
                onClick={() => setShowAllOg((v) => !v)}
                style={{
                  background: "linear-gradient(135deg, #f97316, #ec4899)",
                  color: "#ffffff",
                  padding: "0.5rem 1rem",
                  borderRadius: "999px",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "0.875rem",
                  fontWeight: 500,
                }}
              >
                {showAllOg ? "Hide OG for all" : "See OG for all"}
              </button>
            </div>

            <div
              style={{
                maxHeight: "420px",
                overflowX: "auto",
                overflowY: "auto",
                fontSize: "0.7rem",
              }}
            >
              <table
                style={{
                  minWidth: "1100px",
                  width: "100%",
                  borderCollapse: "collapse",
                }}
              >
                <thead
                  style={{
                    backgroundColor:
                      theme.name === "Deep Night"
                        ? "rgba(15,23,42,0.95)"
                        : "rgba(243,244,246,0.92)",
                    color: theme.name === "Deep Night" ? "#e5e7eb" : "#4b5563",
                    position: "sticky",
                    top: 0,
                  }}
                >
                  <tr>
                    {[
                      "URL",
                      "Title",
                      "Description",
                      "Keywords",
                      "Canonical",
                      "Robots Tag",
                      "Language",
                      "JSON-LD",
                      "DOM Elements Count",
                      "Style Tag Count",
                      "Error",
                    ].map((header) => (
                      <th
                        key={header}
                        style={{
                          border: "1px solid #e5e7eb",
                          padding: "0.25rem 0.5rem",
                          textAlign: "left",
                          fontWeight: 600,
                        }}
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <>
                      <tr key={row.url}>
                        <td
                          style={{
                            border: "1px solid #e5e7eb",
                            padding: "0.25rem 0.5rem",
                            minWidth: "150px",
                          }}
                        >
                          {row.url}
                        </td>
                        <td
                          style={{
                            border: "1px solid #e5e7eb",
                            padding: "0.25rem 0.5rem",
                            minWidth: "150px",
                          }}
                        >
                          {row.title}
                        </td>
                        <td
                          style={{
                            border: "1px solid #e5e7eb",
                            padding: "0.25rem 0.5rem",
                            minWidth: "150px",
                          }}
                        >
                          {row.description}
                        </td>
                        <td
                          style={{
                            border: "1px solid #e5e7eb",
                            padding: "0.25rem 0.5rem",
                            minWidth: "150px",
                          }}
                        >
                          {row.keywords || ""}
                        </td>
                        <td
                          style={{
                            border: "1px solid #e5e7eb",
                            padding: "0.25rem 0.5rem",
                            minWidth: "150px",
                          }}
                        >
                          {row.canonical}
                        </td>
                        <td
                          style={{
                            border: "1px solid #e5e7eb",
                            padding: "0.25rem 0.5rem",
                            minWidth: "150px",
                          }}
                        >
                          {row.robots}
                        </td>
                        <td
                          style={{
                            border: "1px solid #e5e7eb",
                            padding: "0.25rem 0.5rem",
                            minWidth: "150px",
                          }}
                        >
                          {row.language}
                        </td>
                        <td
                          style={{
                            border: "1px solid #e5e7eb",
                            padding: "0.25rem 0.5rem",
                            minWidth: "150px",
                          }}
                        >
                          {row.jsonld}
                        </td>
                        <td
                          style={{
                            border: "1px solid #e5e7eb",
                            padding: "0.25rem 0.5rem",
                            textAlign: "right",
                          }}
                        >
                          {row.domElements}
                        </td>
                        <td
                          style={{
                            border: "1px solid #e5e7eb",
                            padding: "0.25rem 0.5rem",
                            textAlign: "right",
                          }}
                        >
                          {row.styleTags}
                        </td>
                        <td
                          style={{
                            border: "1px solid #e5e7eb",
                            padding: "0.25rem 0.5rem",
                          }}
                        >
                          {row.error && (
                            <div
                              style={{ marginTop: "0.15rem", color: "#b91c1c" }}
                            >
                              {row.error}
                            </div>
                          )}
                        </td>
                      </tr>
                      {showAllOg && (
                        <tr key={`${row.url}-og`}>
                          <td
                            colSpan={11}
                            style={{
                              border: "1px solid #e5e7eb",
                              padding: "0.4rem 0.6rem",
                              backgroundColor: "rgba(249,250,251,0.9)",
                              textAlign: "left",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: "0.2rem",
                                fontSize: "0.7rem",
                              }}
                            >
                              <div>
                                <strong>og:title ：</strong>{" "}
                                {row.og_title || "-"}
                              </div>
                              <div>
                                <strong>og:description ：</strong>{" "}
                                {row.og_description || "-"}
                              </div>
                              <div>
                                <strong>og:type ：</strong> {row.og_type || "-"}
                              </div>
                              <div>
                                <strong>og:image ：</strong>{" "}
                                {row.og_image ? (
                                  <a
                                    href={row.og_image}
                                    target="_blank"
                                    rel="noreferrer"
                                    style={{ color: "#2563eb" }}
                                  >
                                    Open image
                                  </a>
                                ) : (
                                  "-"
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>

            <div
              style={{
                marginTop: "0.75rem",
                fontSize: "0.75rem",
                color: theme.secondaryText,
                textAlign: "left",
              }}
            >
              {(() => {
                const total = rows.length;
                const notIndexed = rows.filter((r) =>
                  r.robots.toLowerCase().includes("noindex"),
                );
                return (
                  <>
                    <div>
                      <strong>Pages discovered:</strong> {total}
                    </div>
                    {notIndexed.length > 0 && (
                      <div style={{ marginTop: "0.25rem" }}>
                        <strong>
                          Not indexed (robots contains "noindex"):
                        </strong>
                        <ul style={{ margin: 0, paddingLeft: "1rem" }}>
                          {notIndexed.map((r) => (
                            <li key={`${r.url}-ni`}>{r.url}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
