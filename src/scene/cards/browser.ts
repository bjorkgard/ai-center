export type BrowserName = "chrome" | "edge" | "firefox" | "safari" | "other";

// Order matters: Edge and Opera carry "Chrome/", Chrome carries "Safari/".
export function detectBrowser(userAgent: string): BrowserName {
  if (/\bEdg(e|A|iOS)?\//.test(userAgent)) return "edge";
  if (/\b(Firefox|FxiOS)\//.test(userAgent)) return "firefox";
  if (/\b(Chrome|CriOS|Chromium)\//.test(userAgent)) return "chrome";
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(userAgent)) return "safari";
  return "other";
}

export interface WebglCopy {
  body: string;
  link: { label: string; href: string };
}

const ACCELERATION = "Turn on hardware acceleration, then reload.";
const UPDATE = "Update your browser and system, then reload."; // Safari has no setting [unverified] (DR16)

// Chrome and Edge link to the vendor help home; no specific article was verified [unverified].
const HELP: Record<BrowserName, WebglCopy> = {
  chrome: {
    body: ACCELERATION,
    link: {
      label: "How to turn on hardware acceleration",
      href: "https://support.google.com/chrome/",
    },
  },
  edge: {
    body: ACCELERATION,
    link: {
      label: "How to turn on hardware acceleration",
      href: "https://support.microsoft.com/microsoft-edge",
    },
  },
  firefox: {
    body: ACCELERATION,
    link: {
      label: "How to turn on hardware acceleration",
      href: "https://support.mozilla.org/kb/performance-settings",
    },
  },
  safari: {
    body: UPDATE,
    link: { label: "WebGL help", href: "https://get.webgl.org/" },
  },
  other: {
    body: UPDATE,
    link: { label: "WebGL help", href: "https://get.webgl.org/" },
  },
};

export function webglCopy(browser: BrowserName): WebglCopy {
  return HELP[browser];
}
