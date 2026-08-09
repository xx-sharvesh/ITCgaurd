/**
 * Browser-side file saving.
 *
 * Everything here touches the DOM, so every entry point asserts it is running
 * in a browser first. In Next.js the same module graph is evaluated on the
 * server during render, and a bare `document.createElement` there produces a
 * ReferenceError inside React's render phase — which surfaces to the user as a
 * blank page rather than "you called a download helper on the server".
 */

import * as XLSX from "xlsx";

/** True only in a real browser with a DOM. */
export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/**
 * Throw a diagnosable error rather than letting a DOM global blow up.
 * Callers should reach these helpers from an event handler, never from render
 * or a server action.
 */
export function assertBrowser(fn: string): void {
  if (!isBrowser()) {
    throw new Error(
      `${fn}() can only run in the browser. Call it from a client event handler ` +
        `("use client" + onClick), not during server rendering.`,
    );
  }
}

/**
 * Generic save-to-disk. Payload first, matching `downloadWorkbook(wb, name)`.
 *
 * The object URL is revoked on the next macrotask rather than synchronously:
 * Safari aborts the download if the URL dies in the same tick as the click.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  assertBrowser("downloadBlob");

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";

  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Save a workbook as .xlsx.
 *
 * We use `XLSX.write(..., { type: "array" })` + Blob rather than
 * `XLSX.writeFile`. `writeFile` works in the browser, but it builds its own
 * anchor internally, which means we cannot control the revoke timing above and
 * cannot reuse the server guard. Going through `downloadBlob` keeps exactly one
 * code path for "a file reached the user's Downloads folder".
 *
 * `cellDates: false` is deliberate: date cells are emitted as Excel serial
 * numbers carrying our `dd-mmm-yyyy` number format, which every version of
 * Excel and LibreOffice treats as a real, sortable date. The ISO-8601 date
 * cells that `cellDates: true` produces are only understood by Excel 2016+.
 */
export function downloadWorkbook(wb: XLSX.WorkBook, filename: string): void {
  assertBrowser("downloadWorkbook");

  const name = filename.toLowerCase().endsWith(".xlsx") ? filename : `${filename}.xlsx`;
  const data = XLSX.write(wb, { bookType: "xlsx", type: "array", cellDates: false }) as ArrayBuffer;

  downloadBlob(new Blob([data], { type: XLSX_MIME }), name);
}
