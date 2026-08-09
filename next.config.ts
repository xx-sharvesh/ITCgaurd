import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * Content Security Policy.
 *
 * The strongest single control this app has, because it holds even if an XSS
 * hole is later introduced: an injected <script> has nowhere to send the data
 * it steals. That matters more here than in most apps — the whole product
 * promise is that a company's purchase ledger never leaves their machine, and
 * `connect-src 'self'` is what makes that a technical guarantee rather than a
 * marketing line.
 *
 * `unsafe-inline` on script-src is a real weakening and is not here by
 * accident: Next's App Router inlines its hydration bootstrap, and a nonce
 * cannot be applied to statically prerendered pages (which `/` and `/demo`
 * both are). The mitigation that actually contains the risk is the strict
 * connect-src / form-action pair below — exfiltration is blocked even if
 * script execution is achieved.
 *
 * `unsafe-eval` is dev-only, for React Fast Refresh.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  // Tailwind and next/font inject style tags at runtime.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  // Fonts are self-hosted by next/font — no CDN origin is ever needed.
  "font-src 'self' data:",
  // The only permitted network destination is this origin. In dev the HMR
  // websocket also needs ws:. Nothing else — no analytics, no CDN, no
  // third-party beacon can receive ledger data.
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  // Blob URLs back the CSV/XLSX download path.
  "object-src 'none'",
  "base-uri 'self'",
  // Login credentials cannot be POSTed to another origin.
  "form-action 'self'",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // Clickjacking. frame-ancestors above is the modern control; this is the
  // fallback for older browsers that ignore it.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Nothing in this app uses a camera, microphone, location or payment API.
  // Denying them outright means a future dependency cannot quietly start.
  {
    key: "Permissions-Policy",
    value: [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "magnetometer=()",
      "gyroscope=()",
      "accelerometer=()",
      "interest-cohort=()",
    ].join(", "),
  },
  // Isolate this origin's browsing context group so a malicious opener cannot
  // reach into it, and block cross-origin subresources that do not opt in.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig: NextConfig = {
  // Never advertise the framework version — it is free reconnaissance for
  // anyone matching a target against a CVE list.
  poweredByHeader: false,

  // Defence in depth against a reflected-XSS-via-URL class of bug: Next will
  // not serve a response whose body echoes an unescaped query parameter.
  reactStrictMode: true,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          ...securityHeaders,
          // HSTS only in production. Setting it in dev would pin localhost to
          // https in the browser's preload cache and break the dev server in a
          // way that is genuinely painful to undo.
          ...(isDev
            ? []
            : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]),
        ],
      },
      {
        // Anything under /api is data, never a document, and must never be
        // cached by a proxy or the browser — a reconciliation response
        // contains the client's ledger.
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, private" },
          { key: "Pragma", value: "no-cache" },
        ],
      },
    ];
  },
};

export default nextConfig;
