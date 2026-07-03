import { wordpressSiteHealth, wordpressSiteHref } from "@/lib/wordpress-apps";

describe("wordpressSiteHealth", () => {
  it("reports a serving site as healthy", () => {
    expect(wordpressSiteHealth({ ready: true, replicas: 1 })).toBe("healthy");
  });

  it("reports a starting site (replicas requested, none ready) as progressing", () => {
    expect(wordpressSiteHealth({ ready: false, replicas: 1 })).toBe("progressing");
  });

  it("reports a scaled-to-zero site as degraded", () => {
    expect(wordpressSiteHealth({ ready: false, replicas: 0 })).toBe("degraded");
  });
});

describe("wordpressSiteHref", () => {
  it("links to the site management panel", () => {
    expect(wordpressSiteHref("blog")).toBe("/wordpress/blog");
  });

  it("escapes unusual site ids", () => {
    expect(wordpressSiteHref("a b")).toBe("/wordpress/a%20b");
  });
});
