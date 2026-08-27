function Icon({
  name,
  size = 18,
}: {
  name: "home" | "download" | "book" | "close" | "back" | "picture" | "globe";
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
    case "picture":
      return (
        <svg {...common} aria-hidden>
          <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="8.5" cy="8.5" r="1.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M21 15.5l-5-5.5L5 21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "globe":
      return (
        <svg {...common} aria-hidden>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
          <path d="M3 12h18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path
            d="M12 3c2.6 2.4 4 5.6 4 9s-1.4 6.6-4 9c-2.6-2.4-4-5.6-4-9s1.4-6.6 4-9Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      );
    default:
      return null;
  }
}

export default Icon;
