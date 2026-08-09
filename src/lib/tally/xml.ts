/**
 * A small, forgiving XML reader for Tally responses.
 *
 * Why not a library: no new npm dependencies are allowed here, and every
 * general-purpose parser we could add is *stricter* than Tally's output, which
 * would mean rejecting real registers over quirks Tally has shipped for twenty
 * years. Why not DOMParser: this runs in the Node server runtime, where it does
 * not exist.
 *
 * The three Tally quirks this file exists to absorb — all observed in the
 * wild, all of which make the response reject as XML in any strict parser:
 *
 *  1. Raw, unescaped `&` in ledger and party names. Indian firm names are full
 *     of ampersands ("Bharat Tools & Dies"), and Tally writes several fields
 *     out without escaping them.
 *  2. C0 control characters, most commonly `&#4;`, which Tally uses internally
 *     as a *line separator* inside multi-line fields (narration, address).
 *     `&#4;` is not a legal XML 1.0 character even when written as an entity.
 *  3. Truncated responses. Tally closes the socket mid-document when it hits an
 *     internal error part-way through a big export. We still want the vouchers
 *     that did arrive, plus a loud warning — not a total failure.
 *
 * The parser is therefore deliberately tolerant: it auto-closes mismatched
 * tags and never throws on structure. Callers get a tree plus a repair log.
 */

export interface XmlNode {
  /** Tag name, uppercased. Tally emits uppercase with dots: `ALLLEDGERENTRIES.LIST`. */
  name: string;
  /** Attribute names uppercased, values entity-decoded. */
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Direct text content of this element only, entity-decoded, not trimmed. */
  text: string;
}

export type XmlRepairKind =
  | "BOM"
  | "RAW_CONTROL_CHAR"
  | "CONTROL_ENTITY"
  | "BARE_AMPERSAND"
  | "PREAMBLE_JUNK";

export interface XmlRepair {
  kind: XmlRepairKind;
  count: number;
}

export interface SanitizedXml {
  xml: string;
  repairs: XmlRepair[];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * An `&` that already begins a well-formed entity. Only the five XML-defined
 * names plus numeric references count — anything else (`&nbsp;`, `&Rs;`) is
 * treated as a literal ampersand that Tally forgot to escape, because XML has
 * no HTML entity set and Tally does not emit one deliberately.
 */
const VALID_ENTITY = /&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/y;

/**
 * C0 controls that XML 1.0 forbids outright (tab, LF and CR are legal).
 * Built from a string rather than a regex literal so that no literal control
 * character is ever pasted into this source file.
 */
const RAW_CONTROL = new RegExp("[\u0000-\u0008\u000B\u000C\u000E-\u001F]", "g");

/**
 * The same characters written as entities — `&#4;` is the one Tally emits.
 * Decimal 9/10/13 and hex 9/A/D are deliberately excluded: tab, LF and CR are
 * legal XML and appear as real formatting inside Tally's output.
 */
const CONTROL_ENTITY =
  /&#(?:0*(?:[0-8]|1[124-9]|2[0-9]|3[01])|[xX]0*(?:[0-8b-cB-Ce-fE-F]|1[0-9a-fA-F]));/g;

/**
 * Remove the C0 control characters XML 1.0 forbids. Shared with the request
 * builders, which must not let one reach Tally either.
 */
export function stripControlChars(value: string): string {
  return value.replace(RAW_CONTROL, "");
}

/**
 * Make a Tally response safe to walk.
 *
 * Order matters: control characters are removed before ampersand repair, so
 * that a legitimate `&#4;` is consumed as a control entity rather than being
 * double-escaped into the literal text "&#4;".
 */
export function sanitizeTallyXml(raw: string): SanitizedXml {
  const repairs: XmlRepair[] = [];
  let xml = raw;

  if (xml.charCodeAt(0) === 0xfeff) {
    xml = xml.slice(1);
    repairs.push({ kind: "BOM", count: 1 });
  }

  // Tally occasionally prefixes the envelope with a stray blank line or an
  // HTTP-ish banner when a plain GET and a POST race on the same socket.
  const firstTag = xml.indexOf("<");
  if (firstTag > 0 && xml.slice(0, firstTag).trim() !== "") {
    repairs.push({ kind: "PREAMBLE_JUNK", count: firstTag });
    xml = xml.slice(firstTag);
  }

  const rawControls = xml.match(RAW_CONTROL);
  if (rawControls) {
    repairs.push({ kind: "RAW_CONTROL_CHAR", count: rawControls.length });
    xml = xml.replace(RAW_CONTROL, " ");
  }

  const controlEntities = xml.match(CONTROL_ENTITY);
  if (controlEntities) {
    repairs.push({ kind: "CONTROL_ENTITY", count: controlEntities.length });
    // A space, not a newline: every field we consume downstream is scalar
    // (names, numbers, dates), so a line break would only have to be collapsed
    // again a moment later.
    xml = xml.replace(CONTROL_ENTITY, " ");
  }

  const { text: escaped, count: bareAmps } = escapeBareAmpersands(xml);
  if (bareAmps > 0) {
    repairs.push({ kind: "BARE_AMPERSAND", count: bareAmps });
    xml = escaped;
  }

  return { xml, repairs };
}

/**
 * Escape every `&` that does not already open a valid entity.
 *
 * Done with a sticky regex probe rather than one big negative lookahead so the
 * scan stays linear on multi-megabyte registers.
 */
function escapeBareAmpersands(xml: string): { text: string; count: number } {
  let count = 0;
  let out = "";
  let last = 0;

  for (let i = xml.indexOf("&"); i !== -1; i = xml.indexOf("&", i + 1)) {
    VALID_ENTITY.lastIndex = i;
    if (VALID_ENTITY.test(xml)) continue;
    out += xml.slice(last, i) + "&amp;";
    last = i + 1;
    count++;
  }

  if (count === 0) return { text: xml, count: 0 };
  return { text: out + xml.slice(last), count };
}

export function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (whole: string, body: string): string => {
      if (body.charCodeAt(0) === 35 /* # */) {
        const hex = body[1] === "x" || body[1] === "X";
        const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
        // Control characters are Tally's internal separators — see file header.
        if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) return " ";
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? whole : named;
    },
  );
}

interface ParsedTag {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  /** Index just past the closing `>`. */
  end: number;
}

export interface XmlDocument {
  root: XmlNode;
  /**
   * Elements still open when the input ran out, outermost first. Non-empty
   * means the response was truncated — Tally cutting the socket part-way
   * through a big export is the usual cause, and it must never be mistaken for
   * "that's all the vouchers there were".
   */
  unclosed: string[];
}

/**
 * Walk XML into a tree. Never throws.
 *
 * `root` is a synthetic `#document` node; real content is in `root.children`.
 * Children are attached at open-tag time, so a document truncated mid-way
 * still yields everything that arrived.
 */
export function parseXml(xml: string): XmlNode {
  return parseXmlDocument(xml).root;
}

export function parseXmlDocument(xml: string): XmlDocument {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  const len = xml.length;

  while (i < len) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      appendText(stack[stack.length - 1], xml.slice(i));
      break;
    }
    if (lt > i) appendText(stack[stack.length - 1], xml.slice(i, lt));

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      const body = xml.slice(lt + 9, end === -1 ? len : end);
      // CDATA is literal: no entity decoding.
      stack[stack.length - 1].text += body;
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt + 2);
      i = end === -1 ? len : end + 1;
      continue;
    }
    if (xml.startsWith("</", lt)) {
      const end = xml.indexOf(">", lt + 2);
      const name = xml.slice(lt + 2, end === -1 ? len : end).trim().toUpperCase();
      closeTag(stack, name);
      i = end === -1 ? len : end + 1;
      continue;
    }

    const tag = readTag(xml, lt);
    if (tag === null) {
      // A lone `<` in text. Tally does this inside narration ("qty < 10").
      appendText(stack[stack.length - 1], "<");
      i = lt + 1;
      continue;
    }

    const node: XmlNode = { name: tag.name, attrs: tag.attrs, children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    if (!tag.selfClosing) stack.push(node);
    i = tag.end;
  }

  return { root, unclosed: stack.slice(1).map((node) => node.name) };
}

function appendText(node: XmlNode, chunk: string): void {
  if (chunk === "") return;
  node.text += decodeEntities(chunk);
}

/**
 * Pop to the matching open element. If the close tag matches nothing on the
 * stack it is discarded; if it matches something below the top, everything
 * above is auto-closed. Both happen in truncated or interleaved Tally output.
 */
function closeTag(stack: XmlNode[], name: string): void {
  for (let depth = stack.length - 1; depth > 0; depth--) {
    if (stack[depth].name === name) {
      stack.length = depth;
      return;
    }
  }
}

/** Read an open tag starting at `<`. Returns null if it is not a tag at all. */
function readTag(xml: string, start: number): ParsedTag | null {
  const nameStart = start + 1;
  let p = nameStart;
  while (p < xml.length && !/[\s/>]/.test(xml[p])) p++;
  const name = xml.slice(nameStart, p).toUpperCase();
  if (name === "" || !/^[A-Z_:][A-Z0-9_.:\-]*$/.test(name)) return null;

  const attrs: Record<string, string> = {};
  let selfClosing = false;

  while (p < xml.length) {
    const ch = xml[p];
    if (ch === ">") {
      p++;
      break;
    }
    if (ch === "/") {
      selfClosing = true;
      p++;
      continue;
    }
    if (/\s/.test(ch)) {
      p++;
      continue;
    }

    const attrStart = p;
    while (p < xml.length && !/[\s=/>]/.test(xml[p])) p++;
    const attrName = xml.slice(attrStart, p).toUpperCase();
    while (p < xml.length && /\s/.test(xml[p])) p++;

    if (xml[p] !== "=") {
      // Valueless attribute (HTML-ism Tally does not emit, but be safe).
      if (attrName) attrs[attrName] = "";
      continue;
    }
    p++;
    while (p < xml.length && /\s/.test(xml[p])) p++;

    const quote = xml[p];
    let value: string;
    if (quote === '"' || quote === "'") {
      const close = xml.indexOf(quote, p + 1);
      value = xml.slice(p + 1, close === -1 ? xml.length : close);
      p = close === -1 ? xml.length : close + 1;
    } else {
      const valueStart = p;
      while (p < xml.length && !/[\s>]/.test(xml[p])) p++;
      value = xml.slice(valueStart, p);
    }
    if (attrName) attrs[attrName] = decodeEntities(value);
  }

  return { name, attrs, selfClosing, end: p };
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

export function firstChild(node: XmlNode, ...names: string[]): XmlNode | undefined {
  for (const child of node.children) {
    if (names.includes(child.name)) return child;
  }
  return undefined;
}

export function childrenNamed(node: XmlNode, ...names: string[]): XmlNode[] {
  return node.children.filter((child) => names.includes(child.name));
}

/** Trimmed text of the first direct child with any of these names. */
export function childText(node: XmlNode, ...names: string[]): string {
  const child = firstChild(node, ...names);
  return child === undefined ? "" : collapse(child.text);
}

/** Depth-first search for every descendant with a given name. */
export function findAll(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (child.name === name) out.push(child);
    findAll(child, name, out);
  }
  return out;
}

/** Collapse runs of whitespace (including the spaces we substituted for `&#4;`). */
export function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Element slicing
// ---------------------------------------------------------------------------

export interface ElementSlice {
  xml: string;
  /** True when no matching close tag was found — the response was cut off. */
  truncated: boolean;
}

/**
 * Cut a document into per-element chunks without building a tree for the whole
 * thing first.
 *
 * A 10,000-voucher register is tens of megabytes; slicing lets us parse one
 * voucher at a time, so a single malformed voucher costs us that voucher and
 * not the whole month, and peak memory stays bounded.
 *
 * Nesting-aware and delimiter-aware: `<VOUCHERTYPENAME>` must not be mistaken
 * for the start of a `<VOUCHER>`.
 */
export function sliceElements(xml: string, tagName: string): ElementSlice[] {
  const tag = tagName.toUpperCase();
  const slices: ElementSlice[] = [];
  const upper = xml.toUpperCase();
  const closeTagText = `</${tag}>`;
  let cursor = 0;

  for (;;) {
    const start = indexOfOpenTag(upper, tag, cursor);
    if (start === -1) break;

    const afterOpen = endOfTag(xml, start);
    if (afterOpen.end === -1) {
      slices.push({ xml: xml.slice(start), truncated: true });
      break;
    }
    if (afterOpen.selfClosing) {
      slices.push({ xml: xml.slice(start, afterOpen.end), truncated: false });
      cursor = afterOpen.end;
      continue;
    }

    let depth = 1;
    let scan = afterOpen.end;
    let sliceEnd = -1;
    while (depth > 0) {
      const nextOpen = indexOfOpenTag(upper, tag, scan);
      const nextClose = upper.indexOf(closeTagText, scan);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        const inner = endOfTag(xml, nextOpen);
        if (inner.end === -1) break;
        if (!inner.selfClosing) depth++;
        scan = inner.end;
        continue;
      }
      depth--;
      scan = nextClose + closeTagText.length;
      if (depth === 0) sliceEnd = scan;
    }

    if (sliceEnd === -1) {
      slices.push({ xml: xml.slice(start), truncated: true });
      break;
    }
    slices.push({ xml: xml.slice(start, sliceEnd), truncated: false });
    cursor = sliceEnd;
  }

  return slices;
}

/** Find `<TAG` where the next character really ends the name. */
function indexOfOpenTag(upperXml: string, tag: string, from: number): number {
  const needle = `<${tag}`;
  let at = upperXml.indexOf(needle, from);
  while (at !== -1) {
    const next = upperXml[at + needle.length];
    if (next === undefined || next === ">" || next === "/" || /\s/.test(next)) return at;
    at = upperXml.indexOf(needle, at + 1);
  }
  return -1;
}

/** Index just past the `>` of the tag starting at `start`, quote-aware. */
function endOfTag(xml: string, start: number): { end: number; selfClosing: boolean } {
  let quote = "";
  for (let p = start + 1; p < xml.length; p++) {
    const ch = xml[p];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") {
      return { end: p + 1, selfClosing: xml[p - 1] === "/" };
    }
  }
  return { end: -1, selfClosing: false };
}
