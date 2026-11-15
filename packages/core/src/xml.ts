/**
 * A small, dependency-free XML tokenizer: just enough XML to read GPX in a Web Worker or React
 * Native, where `DOMParser` does not exist. It streams start tags, end tags and text to a handler,
 * skipping the XML declaration, processing instructions, comments and the doctype. It checks that
 * markup is terminated but leaves element nesting to the caller.
 */

/** Thrown for markup the tokenizer cannot read. `offset` is the index in the input. */
export class XmlSyntaxError extends Error {
  override readonly name = "XmlSyntaxError";
  constructor(
    message: string,
    readonly offset: number,
    /** True when the input ends inside a construct (a cut-off file). */
    readonly truncated: boolean,
  ) {
    super(message);
  }
}

export interface XmlHandler {
  /** A start tag. `name` is the qualified name as written; attributes are entity-decoded. */
  open(name: string, attrs: ReadonlyMap<string, string>, selfClosing: boolean, offset: number): void;
  /** An end tag, with the qualified name as written. */
  close(name: string, offset: number): void;
  /** Character data. Raw text still has entity references; CDATA content is literal. */
  text(raw: string, cdata: boolean, offset: number): void;
}

/** The local part of a qualified name: `gpxtpx:hr` is `hr`. */
export function localName(qname: string): string {
  const colon = qname.indexOf(":");
  return colon < 0 ? qname : qname.slice(colon + 1);
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * Decode the five predefined entities and numeric character references. Anything else (such as
 * an HTML `&nbsp;` some exporters write) is left as written rather than rejected.
 */
export function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, ref: string) => {
    if (ref.startsWith("#")) {
      const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ref] ?? whole;
  });
}

const NAME_END = /[\s/>]/;
const QUOTE = 0x22;
const APOSTROPHE = 0x27;
const LT = 0x3c;
const GT = 0x3e;
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function skipPast(xml: string, from: number, terminator: string, what: string, start: number): number {
  const end = xml.indexOf(terminator, from);
  if (end < 0) throw new XmlSyntaxError(`unterminated ${what}`, start, true);
  return end + terminator.length;
}

/** Index of the `>` that closes the tag starting at `start`, honoring quoted attribute values. */
function tagEnd(xml: string, start: number): number {
  // Character codes, not one-character strings: this runs over every byte of a large file.
  let quote = 0;
  for (let i = start + 1; i < xml.length; i++) {
    const c = xml.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === QUOTE || c === APOSTROPHE) {
      quote = c;
    } else if (c === GT) {
      return i;
    } else if (c === LT) {
      throw new XmlSyntaxError("a tag is missing its closing >", start, false);
    }
  }
  throw new XmlSyntaxError("unterminated tag", start, true);
}

/** The attributes of every tag without any, shared: handlers only read them. */
const NO_ATTRS: ReadonlyMap<string, string> = new Map();

function parseAttrs(source: string, start: number): ReadonlyMap<string, string> {
  // Most tags (`<ele>`, `<time>`) have nothing after their name.
  if (source === "") return NO_ATTRS;
  const attrs = new Map<string, string>();
  ATTR.lastIndex = 0;
  let consumed = 0;
  for (let m = ATTR.exec(source); m; m = ATTR.exec(source)) {
    if (source.slice(consumed, m.index).trim() !== "") break;
    attrs.set(m[1] as string, decodeEntities(m[2] ?? m[3] ?? ""));
    consumed = ATTR.lastIndex;
  }
  if (source.slice(consumed).trim() !== "") throw new XmlSyntaxError("a tag has a malformed attribute", start, false);
  return attrs;
}

/** Tokenize `xml`, calling `handler` for each start tag, end tag and run of text, in order. */
export function tokenizeXml(xml: string, handler: XmlHandler): void {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      handler.text(xml.slice(i), false, i);
      return;
    }
    if (lt > i) handler.text(xml.slice(i, lt), false, i);
    const next = xml[lt + 1];
    if (next === "?") {
      i = skipPast(xml, lt + 2, "?>", "processing instruction", lt);
    } else if (next === "!") {
      if (xml.startsWith("<!--", lt)) {
        i = skipPast(xml, lt + 4, "-->", "comment", lt);
      } else if (xml.startsWith("<![CDATA[", lt)) {
        const end = xml.indexOf("]]>", lt + 9);
        if (end < 0) throw new XmlSyntaxError("unterminated CDATA section", lt, true);
        handler.text(xml.slice(lt + 9, end), true, lt);
        i = end + 3;
      } else {
        // A doctype, possibly with an internal subset in brackets.
        const bracket = xml.indexOf("[", lt);
        const close = xml.indexOf(">", lt);
        if (close < 0) throw new XmlSyntaxError("unterminated declaration", lt, true);
        i = bracket >= 0 && bracket < close ? skipPast(xml, bracket, "]", "declaration", lt) : close;
        i = skipPast(xml, i, ">", "declaration", lt);
      }
    } else if (next === "/") {
      const end = xml.indexOf(">", lt);
      if (end < 0) throw new XmlSyntaxError("unterminated end tag", lt, true);
      const name = xml.slice(lt + 2, end).trim();
      if (!name || NAME_END.test(name)) throw new XmlSyntaxError("a malformed end tag", lt, false);
      handler.close(name, lt);
      i = end + 1;
    } else {
      const end = tagEnd(xml, lt);
      const selfClosing = xml[end - 1] === "/";
      const body = xml.slice(lt + 1, selfClosing ? end - 1 : end);
      const nameMatch = NAME_END.exec(body);
      const nameLength = nameMatch ? nameMatch.index : body.length;
      const name = body.slice(0, nameLength);
      if (!name) throw new XmlSyntaxError("a tag has no name", lt, false);
      handler.open(name, parseAttrs(body.slice(nameLength), lt), selfClosing, lt);
      if (selfClosing) handler.close(name, lt);
      i = end + 1;
    }
  }
}
