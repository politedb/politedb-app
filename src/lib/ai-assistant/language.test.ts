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
    expect(resolveReplyLanguage("xin chaof").code).toBe("vie");
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

  it("keeps the first user language for the chat session", () => {
    expect(
      resolveReplyLanguage("media asset", [
        {
          role: "user",
          text: "bạn lấy được data các bảng không",
        },
        {
          role: "assistant",
          text: "Bạn muốn truy vấn dữ liệu từ bảng nào?",
        },
      ]).code
    ).toBe("vie");
  });

  it("allows an explicit language switch in the latest message", () => {
    expect(
      resolveReplyLanguage("please reply in English", [
        {
          role: "user",
          text: "bạn lấy được data các bảng không",
        },
      ]).code
    ).toBe("eng");
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
