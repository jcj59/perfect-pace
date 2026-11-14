import { describe, expect, it } from "vitest";
import { XmlSyntaxError, decodeEntities, localName, tokenizeXml } from "../src/xml.ts";

type Event = [string, ...unknown[]];

function events(xml: string): Event[] {
  const out: Event[] = [];
  tokenizeXml(xml, {
    open: (name, attrs, selfClosing) => out.push(["open", name, Object.fromEntries(attrs), selfClosing]),
    close: (name) => out.push(["close", name]),
    text: (raw, cdata) => out.push(["text", raw, cdata]),
  });
  return out;
}

function syntaxError(xml: string): XmlSyntaxError {
  try {
    events(xml);
  } catch (e) {
    if (e instanceof XmlSyntaxError) return e;
    throw e;
  }
  throw new Error(`expected a syntax error for ${xml}`);
}

describe("tokenizeXml", () => {
  it("streams start tags, attributes, text and end tags in order", () => {
    expect(events(`<a x="1" y='two'>hi<b/></a>tail`)).toEqual([
      ["open", "a", { x: "1", y: "two" }, false],
      ["text", "hi", false],
      ["open", "b", {}, true],
      ["close", "b"],
      ["close", "a"],
      ["text", "tail", false],
    ]);
  });

  it("skips the declaration, processing instructions, comments and doctypes", () => {
    const xml = `<?xml version="1.0"?><?pi data?><!-- c <a> --><!DOCTYPE g [<!ENTITY e "v">]><!DOCTYPE h><g></g>`;
    expect(events(xml)).toEqual([
      ["open", "g", {}, false],
      ["close", "g"],
    ]);
  });

  it("passes CDATA through literally", () => {
    expect(events(`<n><![CDATA[a & <b>]]></n>`)).toContainEqual(["text", "a & <b>", true]);
  });

  it("keeps prefixes, allows > inside quoted values and whitespace around =", () => {
    expect(events(`<p:a q:href = "x>y" z="a&amp;b" />`)).toEqual([
      ["open", "p:a", { "q:href": "x>y", z: "a&b" }, true],
      ["close", "p:a"],
    ]);
  });

  it("allows whitespace inside end tags", () => {
    expect(events(`<a></a >`)).toEqual([
      ["open", "a", {}, false],
      ["close", "a"],
    ]);
  });

  it.each([
    ["<a", "unterminated tag", true],
    ["<a x='1>", "unterminated tag", true],
    ["<!-- open", "unterminated comment", true],
    ["<?xml", "unterminated processing instruction", true],
    ["<a><![CDATA[x", "unterminated CDATA section", true],
    ["<!DOCTYPE g", "unterminated declaration", true],
    ["<!DOCTYPE g [<!ENTITY e 'v'>", "unterminated declaration", true],
    ["<!DOCTYPE g []", "unterminated declaration", true],
    ["<a></a", "unterminated end tag", true],
    ["<a <b>", "a tag is missing its closing >", false],
    ["<a x=1>", "a tag has a malformed attribute", false],
    ["<a x='1' junk>", "a tag has a malformed attribute", false],
    ["< a>", "a tag has no name", false],
    ["<a></ >", "a malformed end tag", false],
    ["<a></a b>", "a malformed end tag", false],
  ])("rejects %j with %j", (xml, message, truncated) => {
    const e = syntaxError(xml);
    expect(e.message).toBe(message);
    expect(e.truncated).toBe(truncated);
    expect(e.offset).toBeGreaterThanOrEqual(0);
  });
});

describe("decodeEntities", () => {
  it("decodes predefined and numeric references and leaves unknown ones", () => {
    expect(decodeEntities("&lt;a&gt; &amp; &quot;&apos; &#233;&#x2192; &nbsp; &#x110000; &")).toBe(
      "<a> & \"' é→ &nbsp; &#x110000; &",
    );
    expect(decodeEntities("plain")).toBe("plain");
  });
});

describe("localName", () => {
  it("strips a prefix", () => {
    expect(localName("gpxtpx:hr")).toBe("hr");
    expect(localName("trkpt")).toBe("trkpt");
  });
});
