import { useState } from "react";
import axios from "axios";
import * as XLSX from "xlsx";
import "./index.css";

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
    } catch (e: any) {
      setMessage(`Failed to analyze sitemap: ${String(e)}`);
    } finally {
      setIsRunning(false);
    }
  };

  const handleDownload = () => {
    exportToExcel(rows);
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
          </div>
        </div>

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

        {message && (
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

        {rows.length > 0 && (
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
                const indexed = rows.filter(
                  (r) => !r.robots.toLowerCase().includes("noindex"),
                ).length;
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
