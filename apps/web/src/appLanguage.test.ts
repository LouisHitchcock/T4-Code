import { describe, expect, it } from "vitest";

import { applyDocumentLanguage, getAppLanguageDetails } from "./appLanguage";

describe("getAppLanguageDetails", () => {
  it("returns RTL metadata for Persian", () => {
    expect(getAppLanguageDetails("fa")).toMatchObject({
      locale: "fa-IR",
      lang: "fa",
      dir: "rtl",
    });
  });
});

describe("applyDocumentLanguage", () => {
  it("applies lang, dir, and dataset state to the provided root element", () => {
    const root = {
      lang: "",
      dir: "",
      dataset: {},
    } as unknown as HTMLElement;

    applyDocumentLanguage("fa", root);

    expect(root.lang).toBe("fa");
    expect(root.dir).toBe("rtl");
    expect(root.dataset.language).toBe("fa");
  });
});
