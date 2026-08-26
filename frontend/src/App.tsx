import { useRef, useState } from "react";
import axios from "axios";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import "./index.css";
import { toast } from "sonner";
import AppShell from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import Icon from "./Icon";
import { THEMES } from "./theme";
import DomainMonitorPage from "./domain-monitor/DomainMonitorPage";

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
  og_url?: string;
};

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

function normalizeForCompare(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const origin = u.origin.toLowerCase();
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${origin}${path}`;
  } catch {
    return rawUrl.trim();
  }
}

function isUrlOgCanonicalMatch(row: SeoRow): boolean {
  const url = normalizeForCompare(row.url || "");
  const canonical = normalizeForCompare(row.canonical || "");
  const ogUrl = normalizeForCompare(row.og_url || "");

  // Require URL + at least one of canonical/og:url to compare
  const hasCanonical = !!row.canonical;
  const hasOgUrl = !!row.og_url;
  if (!url || (!hasCanonical && !hasOgUrl)) return false;

  const canonicalOk = !hasCanonical || canonical === url;
  const ogOk = !hasOgUrl || ogUrl === url;
  const crossOk =
    !hasCanonical || !hasOgUrl || canonical === ogUrl || canonical === url || ogUrl === url;

  return canonicalOk && ogOk && crossOk;
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
    "URL Match": isUrlOgCanonicalMatch(r) ? "true" : "false",
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
  const [themeIndex] = useState(0);
  const [showAllOg, setShowAllOg] = useState(false);
  const [showMismatchInfo, setShowMismatchInfo] = useState(false);
  const [mismatchCopied, setMismatchCopied] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [activePage, setActivePage] = useState<"home" | "download" | "imgextract" | "domains">("home");
  const [downloadFile, setDownloadFile] = useState<File | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [isSitemapPreviewOpen, setIsSitemapPreviewOpen] = useState(false);
  const [sitemapPreviewText, setSitemapPreviewText] = useState<string>("");
  const [sitemapPreviewName, setSitemapPreviewName] = useState<string>("sitemap.xml");

  // HTML Image Extractor page state
  const [htmlInput, setHtmlInput] = useState("");
  const [extractedImages, setExtractedImages] = useState<string[]>([]);
  const [isImgDownloading, setIsImgDownloading] = useState(false);
  const [imgDownloadProgress, setImgDownloadProgress] = useState(0);
  const [imgDownloadMessage, setImgDownloadMessage] = useState<string | null>(null);

  const runIdRef = useRef(0);
  const runTimersRef = useRef<number[]>([]);

  const theme = THEMES[themeIndex];

  const clearRunTimers = () => {
    runTimersRef.current.forEach((id) => window.clearTimeout(id));
    runTimersRef.current = [];
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

    runIdRef.current += 1;
    const runId = runIdRef.current;
    clearRunTimers();

    setIsRunning(true);
    setRows([]);
    setProgress(0);
    setMessage(null);

    // Hardcoded progress steps
    runTimersRef.current.push(
      window.setTimeout(() => {
        if (runIdRef.current !== runId) return;
        setProgress(30);
      }, 3000),
    );
    runTimersRef.current.push(
      window.setTimeout(() => {
        if (runIdRef.current !== runId) return;
        setProgress(60);
      }, 6000),
    );

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
      // Finish progress in 2s, then reveal results
      runTimersRef.current.push(
        window.setTimeout(() => {
          if (runIdRef.current !== runId) return;
          setProgress(100);
          setRows(results);
          setMessage(`Analysis completed for ${results.length} URLs.`);
          setIsRunning(false);
          clearRunTimers();
        }, 2000),
      );
    } catch (e: unknown) {
      clearRunTimers();
      const message =
        e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
      setProgress(0);
      setMessage(`Failed to analyze sitemap: ${message}`);
      setIsRunning(false);
    }
  };

  const handleDownload = () => {
    exportToExcel(rows);
  };

  const handleExtractMismatch = () => {
    const mismatched = rows.filter(
      (row) => (row.canonical || row.og_url) && !isUrlOgCanonicalMatch(row)
    );
    if (mismatched.length === 0) {
      toast.info("No URL mismatches found", {
        description: "Every URL matches its canonical and OG URL.",
      });
      return;
    }
    const text = mismatched.map((row, i) => `${i + 1}. ${row.url}`).join("\n");
    navigator.clipboard.writeText(text).then(() => {
      setMismatchCopied(true);
      setTimeout(() => setMismatchCopied(false), 2000);
    });
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

  // ── HTML Image Extractor helpers ─────────────────────────────────────────
  const extractImagesFromHtml = () => {
    if (!htmlInput.trim()) return;
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlInput, "text/html");
    const urls = new Set<string>();

    // <img src> and <img data-src>
    doc.querySelectorAll("img[src]").forEach((el) => {
      const src = el.getAttribute("src");
      if (src && !src.startsWith("data:")) urls.add(src);
    });
    doc.querySelectorAll("img[data-src]").forEach((el) => {
      const src = el.getAttribute("data-src");
      if (src && !src.startsWith("data:")) urls.add(src);
    });

    // background-image: url(...) in style attributes
    doc.querySelectorAll("[style]").forEach((el) => {
      const style = el.getAttribute("style") || "";
      const matches = style.matchAll(/url\(['"]?([^'")\s]+)['"]?\)/g);
      for (const match of matches) {
        const u = match[1];
        if (u && !u.startsWith("data:")) urls.add(u);
      }
    });

    // <source srcset>
    doc.querySelectorAll("source[srcset]").forEach((el) => {
      const srcset = el.getAttribute("srcset") || "";
      srcset.split(",").forEach((part) => {
        const u = part.trim().split(/\s+/)[0];
        if (u && !u.startsWith("data:")) urls.add(u);
      });
    });

    setExtractedImages(Array.from(urls));
    setImgDownloadProgress(0);
    setImgDownloadMessage(
      urls.size === 0 ? "No images found in the pasted HTML." : null,
    );
  };

  const filenameFromImageUrl = (url: string, index: number): string => {
    try {
      const u = new URL(url);
      const parts = u.pathname.split("/").filter(Boolean);
      const last = parts.length
        ? decodeURIComponent(parts[parts.length - 1])
        : "";
      if (last && /\.(jpe?g|png|gif|webp|svg|bmp|ico|avif)$/i.test(last)) {
        return last;
      }
    } catch {
      // fallthrough
    }
    return `image-${index + 1}.jpg`;
  };

  const downloadAllImages = async () => {
    if (!extractedImages.length) return;
    setIsImgDownloading(true);
    setImgDownloadProgress(0);
    setImgDownloadMessage(null);

    try {
      const zip = new JSZip();
      const usedNames = new Map<string, number>();

      for (let i = 0; i < extractedImages.length; i++) {
        const url = extractedImages[i];
        const baseName = filenameFromImageUrl(url, i);
        const count = usedNames.get(baseName) ?? 0;
        usedNames.set(baseName, count + 1);
        const name =
          count === 0
            ? baseName
            : baseName.replace(/(\.[^.]+)$/, `-${count + 1}$1`);

        const resp = await axios.get<ArrayBuffer>(`${API_BASE_URL}/fetch-image`, {
          params: { url },
          responseType: "arraybuffer",
          timeout: 30000,
        });
        zip.file(name, resp.data);
        setImgDownloadProgress(Math.round(((i + 1) / extractedImages.length) * 100));
      }

      const blob = await zip.generateAsync({ type: "blob" });
      downloadBlob(blob, "images.zip");
      setImgDownloadMessage(`Packed ${extractedImages.length} image(s) into images.zip`);
    } catch (e: unknown) {
      const msg =
        e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
      setImgDownloadMessage(`Download failed: ${msg}`);
    } finally {
      setIsImgDownloading(false);
    }
  };
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <AppShell activePage={activePage} onNavigate={setActivePage}>
      {activePage === "domains" ? (
        <DomainMonitorPage />
      ) : (
        <div className="flex items-start justify-center rounded-xl bg-background">
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
        className="fixed left-1/2 top-1/2 z-[70] flex max-h-[min(80vh,720px)] w-[min(920px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm transition-[opacity,transform] duration-200 ease-out"
        style={{
          transform: isSitemapPreviewOpen
            ? "translate(-50%, -50%) scale(1)"
            : "translate(-50%, -50%) scale(0.98)",
          opacity: isSitemapPreviewOpen ? 1 : 0,
          pointerEvents: isSitemapPreviewOpen ? "auto" : "none",
        }}
        role="dialog"
        aria-modal="true"
        aria-hidden={!isSitemapPreviewOpen}
      >
        <div
          className="flex items-center justify-between border-b border-border px-4 py-3"
        >
          <div style={{ fontWeight: 700 }}>Sitemap preview · {sitemapPreviewName}</div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setIsSitemapPreviewOpen(false)}
            aria-label="Close preview"
          >
            <Icon name="close" size={18} />
          </Button>
        </div>
        <pre className="m-0 overflow-auto bg-muted/40 px-4 py-4 text-xs leading-[1.45] text-muted-foreground">
          {sitemapPreviewText}
        </pre>
      </div>


      <Card className="w-full max-w-6xl shadow-sm">
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <CardTitle className="text-2xl tracking-[0.02em] text-foreground">
              SEO Sitemap Analyzer
            </CardTitle>
            <CardDescription>
              Upload a sitemap.xml file and run the existing SEO analysis flow.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowInfo((v) => !v)}
          >
            {showInfo ? "Hide help" : "How to use"}
          </Button>
        </CardHeader>

        {showInfo && (
          <CardContent className="pb-0">
            <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-left text-xs text-muted-foreground">
            <div className="mb-1 font-semibold text-foreground">
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
          </CardContent>
        )}

        <CardContent className="space-y-4">

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

        {activePage === "imgextract" ? (
          <div style={{ marginBottom: "0.5rem" }}>
            <div style={{ textAlign: "left", color: theme.primaryText, fontWeight: 700, marginBottom: "0.25rem" }}>
              HTML Image Extractor
            </div>
            <div style={{ textAlign: "left", color: theme.secondaryText, fontSize: "0.85rem", marginBottom: "1rem" }}>
              Paste HTML from browser Inspect, then download all images automatically.
            </div>

            <textarea
              value={htmlInput}
              onChange={(e) => {
                setHtmlInput(e.target.value);
                setExtractedImages([]);
                setImgDownloadMessage(null);
              }}
              placeholder="Paste your HTML here (e.g. copied from browser DevTools)…"
              rows={7}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "0.6rem 0.75rem",
                borderRadius: "0.5rem",
                border:
                  theme.name === "Deep Night"
                    ? "1px solid rgba(51,65,85,0.7)"
                    : "1px solid rgba(209,213,219,0.9)",
                backgroundColor:
                  theme.name === "Deep Night"
                    ? "rgba(15,23,42,0.9)"
                    : "rgba(249,250,251,0.95)",
                color: theme.primaryText,
                fontSize: "0.78rem",
                fontFamily: "monospace",
                resize: "vertical",
                outline: "none",
                marginBottom: "0.75rem",
              }}
            />

            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center", marginBottom: "0.75rem" }}>
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
                  <Icon name="back" size={18} /> Back
                </span>
              </button>

              <button
                type="button"
                onClick={extractImagesFromHtml}
                disabled={!htmlInput.trim()}
                style={{
                  background: htmlInput.trim()
                    ? "linear-gradient(135deg, #6366f1, #8b5cf6)"
                    : theme.primaryButtonDisabled,
                  color: "#fff",
                  padding: "0.5rem 1rem",
                  borderRadius: "999px",
                  border: "none",
                  cursor: htmlInput.trim() ? "pointer" : "not-allowed",
                  fontSize: "0.875rem",
                  fontWeight: 500,
                }}
              >
                Extract Images
              </button>

              {extractedImages.length > 0 && (
                <>
                <button
                  type="button"
                  onClick={downloadAllImages}
                  disabled={isImgDownloading}
                  style={{
                    background: isImgDownloading
                      ? theme.primaryButtonDisabled
                      : "linear-gradient(135deg, #10b981, #059669)",
                    color: "#fff",
                    padding: "0.5rem 1rem",
                    borderRadius: "999px",
                    border: "none",
                    cursor: isImgDownloading ? "not-allowed" : "pointer",
                    fontSize: "0.875rem",
                    fontWeight: 500,
                  }}
                >
                  {isImgDownloading
                    ? `Downloading… ${imgDownloadProgress}%`
                    : `Download All as ZIP (${extractedImages.length})`}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    const lines = extractedImages
                      .map((url, i) => filenameFromImageUrl(url, i))
                      .join("\n");
                    const blob = new Blob([lines], { type: "text/plain" });
                    downloadBlob(blob, "image-list.txt");
                  }}
                  style={{
                    background: "linear-gradient(135deg, #f97316, #ea580c)",
                    color: "#fff",
                    padding: "0.5rem 1rem",
                    borderRadius: "999px",
                    border: "none",
                    cursor: "pointer",
                    fontSize: "0.875rem",
                    fontWeight: 500,
                  }}
                >
                  Download Name List (.txt)
                </button>
                </>
              )}
            </div>

            {isImgDownloading && (
              <div style={{ marginBottom: "0.75rem", maxWidth: "420px" }}>
                <div style={{ height: "6px", borderRadius: "999px", backgroundColor: "rgba(148,163,184,0.3)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.max(5, imgDownloadProgress)}%`, background: "linear-gradient(90deg, #10b981, #6366f1)", transition: "width 0.3s ease-out" }} />
                </div>
              </div>
            )}

            {imgDownloadMessage && (
              <div style={{ marginBottom: "0.75rem", fontSize: "0.85rem", color: theme.secondaryText, textAlign: "left" }}>
                {imgDownloadMessage}
              </div>
            )}

            {extractedImages.length > 0 && (
              <div>
                <div style={{ fontSize: "0.8rem", fontWeight: 600, color: theme.primaryText, marginBottom: "0.5rem" }}>
                  Found {extractedImages.length} image(s)
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", maxHeight: "320px", overflowY: "auto" }}>
                  {extractedImages.map((url, i) => (
                    <div
                      key={url}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.6rem",
                        padding: "0.4rem 0.6rem",
                        borderRadius: "0.5rem",
                        backgroundColor:
                          theme.name === "Deep Night"
                            ? "rgba(15,23,42,0.7)"
                            : "rgba(243,244,246,0.9)",
                        border:
                          theme.name === "Deep Night"
                            ? "1px solid rgba(51,65,85,0.5)"
                            : "1px solid rgba(229,231,235,0.8)",
                      }}
                    >
                      <img
                        src={url}
                        alt=""
                        style={{ width: "40px", height: "40px", objectFit: "cover", borderRadius: "0.3rem", flexShrink: 0, background: "rgba(148,163,184,0.2)" }}
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                      />
                      <div style={{ flex: 1, overflow: "hidden" }}>
                        <div style={{ fontSize: "0.7rem", color: theme.secondaryText, wordBreak: "break-all", lineHeight: 1.3 }}>
                          {url}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={isImgDownloading}
                        onClick={async () => {
                          try {
                            const resp = await axios.get<ArrayBuffer>(`${API_BASE_URL}/fetch-image`, {
                              params: { url },
                              responseType: "arraybuffer",
                              timeout: 30000,
                            });
                            const ct = ((resp.headers["content-type"] as string | undefined) || "image/jpeg").split(";")[0].trim();
                            const blob = new Blob([resp.data], { type: ct });
                            downloadBlob(blob, filenameFromImageUrl(url, i));
                          } catch {
                            // silently ignore per-item errors
                          }
                        }}
                        style={{
                          flexShrink: 0,
                          background: "rgba(99,102,241,0.12)",
                          border: "1px solid rgba(99,102,241,0.35)",
                          borderRadius: "999px",
                          color: theme.primaryText,
                          padding: "0.2rem 0.6rem",
                          cursor: isImgDownloading ? "not-allowed" : "pointer",
                          fontSize: "0.7rem",
                          fontWeight: 500,
                        }}
                      >
                        Save
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : activePage === "download" ? (
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
          <div className="mb-4 space-y-2">
          <label className="block text-sm font-medium text-foreground">
            Upload sitemap.xml
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Input type="file" accept=".xml" onChange={handleFileChange} className="max-w-xl" />
            {file && (
              <Button
                type="button"
                onClick={() => openSitemapPreview(file)}
                variant="outline"
                size="icon-sm"
                aria-label="Preview sitemap"
                title="Preview sitemap"
              >
                <Icon name="book" size={18} />
              </Button>
            )}
          </div>
        </div>
        )}

        {activePage === "home" && (
          <div
            className="mb-4 flex items-center gap-3"
          >
            <Button
              type="button"
              onClick={handleRun}
              disabled={!file || isRunning}
            >
              {isRunning ? "Running…" : "Run SEO Analysis"}
            </Button>

            {isRunning && (
              <div className="text-sm text-muted-foreground">
                Analyzing… {progress}%
              </div>
            )}
          </div>
        )}

        {activePage === "home" && message && (
          <p className="mb-4 text-sm text-muted-foreground">
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
              <div style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                <button
                  type="button"
                  onClick={handleExtractMismatch}
                  style={{
                    background: "linear-gradient(135deg, #ef4444, #b91c1c)",
                    color: "#ffffff",
                    padding: "0.5rem 1rem",
                    borderRadius: "999px",
                    border: "none",
                    cursor: "pointer",
                    fontSize: "0.875rem",
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  {mismatchCopied ? "Copied!" : "Copy Mismatch URLs"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowMismatchInfo((v) => !v)}
                  style={{
                    background: "transparent",
                    border: `1px solid ${theme.secondaryText}`,
                    color: theme.secondaryText,
                    borderRadius: "50%",
                    width: "1.2rem",
                    height: "1.2rem",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    fontSize: "0.65rem",
                    fontWeight: 700,
                    flexShrink: 0,
                    lineHeight: 1,
                  }}
                >
                  i
                </button>
                {showMismatchInfo && (
                  <div
                    style={{
                      position: "absolute",
                      top: "calc(100% + 0.5rem)",
                      left: 0,
                      zIndex: 100,
                      background: theme.cardBackground,
                      border: "1px solid rgba(128,128,128,0.3)",
                      borderRadius: "0.5rem",
                      padding: "0.75rem",
                      width: "270px",
                      fontSize: "0.75rem",
                      color: theme.primaryText,
                      boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
                    }}
                  >
                    Copies to clipboard every URL where the page URL, <strong>Canonical</strong>, or <strong>OG URL</strong> do not all match — one URL per line, ready to paste.
                    <button
                      type="button"
                      onClick={() => setShowMismatchInfo(false)}
                      style={{
                        display: "block",
                        marginTop: "0.5rem",
                        fontSize: "0.7rem",
                        cursor: "pointer",
                        background: "none",
                        border: "none",
                        color: theme.secondaryText,
                        padding: 0,
                      }}
                    >
                      Close
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div
              className="max-h-[420px] overflow-x-auto overflow-y-auto text-[0.7rem]"
            >
              <table
                style={{
                  minWidth: "1100px",
                  width: "100%",
                  borderCollapse: "collapse",
                }}
              >
                <thead
                  className="sticky top-0 bg-muted/80 text-muted-foreground backdrop-blur"
                >
                  <tr>
                    {[
                      "URL",
                      "Title",
                      "Description",
                      "Keywords",
                      "URL Match",
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
                        className="border border-border px-2 py-1 text-left font-semibold"
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
                          className="min-w-[150px] border border-border px-2 py-1"
                        >
                          {row.url}
                        </td>
                        <td
                          className="min-w-[150px] border border-border px-2 py-1"
                        >
                          {row.title}
                        </td>
                        <td
                          className="min-w-[150px] border border-border px-2 py-1"
                        >
                          {row.description}
                        </td>
                        <td
                          className="min-w-[150px] border border-border px-2 py-1"
                        >
                          {row.keywords || ""}
                        </td>
                        <td
                          className="min-w-[150px] border border-border px-2 py-1"
                        >
                          {isUrlOgCanonicalMatch(row) ? "true" : "false"}
                        </td>
                        <td
                          className="min-w-[150px] border border-border px-2 py-1"
                        >
                          {row.canonical}
                        </td>
                        <td
                          className="min-w-[150px] border border-border px-2 py-1"
                        >
                          {row.robots}
                        </td>
                        <td
                          className="min-w-[150px] border border-border px-2 py-1"
                        >
                          {row.language}
                        </td>
                        <td
                          className="min-w-[150px] border border-border px-2 py-1"
                        >
                          {row.jsonld}
                        </td>
                        <td
                          className="border border-border px-2 py-1 text-right"
                        >
                          {row.domElements}
                        </td>
                        <td
                          className="border border-border px-2 py-1 text-right"
                        >
                          {row.styleTags}
                        </td>
                        <td
                          className="border border-border px-2 py-1"
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
                            colSpan={12}
                            style={{
                              border: "1px solid var(--color-border)",
                              padding: "0.4rem 0.6rem",
                              backgroundColor: "var(--color-muted)",
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
                                <strong>og:url ：</strong> {row.og_url || "-"}
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
                                    className="text-primary hover:underline"
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
              className="mt-3 text-left text-xs text-muted-foreground"
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
          </CardContent>
      </Card>
        </div>
      )}
    </AppShell>
  );
}

export default App;
