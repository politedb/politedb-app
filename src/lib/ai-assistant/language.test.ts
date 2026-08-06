import { describe, expect, it } from "vitest";
import {
  detectLanguageFromText,
  parseExplicitLanguageRequest,
  resolveReplyLanguage,
} from "./language";

describe("resolveReplyLanguage", () => {
  it("detects Vietnamese from diacritics", () => {
    expect(resolveReplyLanguage("xin chào, liệt kê các bảng").code).toBe("vie");
  });

  it("does not misdetect short Vietnamese as French", () => {
    expect(resolveReplyLanguage("lấy max connection").code).toBe("vie");
    expect(resolveReplyLanguage("lay max connection").code).toBe("vie");
  });

  it("detects French from text", () => {
    expect(
      resolveReplyLanguage(
        "Bonjour, pouvez-vous me montrer toutes les tables de cette base de données?"
      ).code
    ).toBe("fra");
  });

  it("detects Japanese from script", () => {
    expect(resolveReplyLanguage("テーブル一覧を表示して").code).toBe("jpn");
  });

  it("parses explicit language switch requests", () => {
    expect(parseExplicitLanguageRequest("please reply in French")?.code).toBe(
      "fra"
    );
    expect(parseExplicitLanguageRequest("tra loi bang tieng Viet")?.code).toBe(
      "vie"
    );
  });
});

describe("detectLanguageFromText", () => {
  it("defaults short ASCII to English", () => {
    expect(detectLanguageFromText("hi").code).toBe("eng");
  });

  it("detects Spanish", () => {
    expect(
      detectLanguageFromText("muéstrame todas las tablas de la base de datos")
        .code
    ).toBe("spa");
  });
});
