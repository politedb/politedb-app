import { franc } from "franc";

/** ISO 639-3 code + human-readable name for LLM prompts. */
export type ReplyLanguageInfo = {
  code: string;
  name: string;
};

const DEFAULT_LANGUAGE: ReplyLanguageInfo = { code: "eng", name: "English" };

/** Languages with hand-written fast-path message templates in the assistant. */
export const LOCALIZED_FAST_PATH_CODES = new Set(["eng", "vie"]);

const ISO_LANGUAGE_NAMES: Record<string, string> = {
  eng: "English",
  vie: "Vietnamese",
  fra: "French",
  deu: "German",
  spa: "Spanish",
  jpn: "Japanese",
  cmn: "Chinese",
  zho: "Chinese",
  kor: "Korean",
  por: "Portuguese",
  ita: "Italian",
  rus: "Russian",
  tha: "Thai",
  ind: "Indonesian",
  arb: "Arabic",
  nld: "Dutch",
  pol: "Polish",
  tur: "Turkish",
  hin: "Hindi",
  ben: "Bengali",
  ukr: "Ukrainian",
  ces: "Czech",
  ell: "Greek",
  heb: "Hebrew",
  swe: "Swedish",
  dan: "Danish",
  fin: "Finnish",
  nor: "Norwegian",
  hun: "Hungarian",
  ron: "Romanian",
  cat: "Catalan",
  msa: "Malay",
  fil: "Filipino",
  swh: "Swahili",
};

const EXPLICIT_LANGUAGE_ALIASES: Array<{ pattern: RegExp; code: string }> = [
  { pattern: /\b(english|tieng anh)\b/i, code: "eng" },
  { pattern: /\b(vietnamese|tieng viet)\b/i, code: "vie" },
  { pattern: /\b(french|francais|français|tieng phap)\b/i, code: "fra" },
  { pattern: /\b(german|deutsch|tieng duc)\b/i, code: "deu" },
  { pattern: /\b(spanish|espanol|español|tieng tay ban nha)\b/i, code: "spa" },
  { pattern: /\b(japanese|nihongo|tieng nhat)\b/i, code: "jpn" },
  { pattern: /\b(chinese|mandarin|tieng trung)\b/i, code: "cmn" },
  { pattern: /\b(korean|hangul|tieng han)\b/i, code: "kor" },
  { pattern: /\b(portuguese|portugues|tieng bo dao nha)\b/i, code: "por" },
  { pattern: /\b(italian|italiano|tieng y)\b/i, code: "ita" },
  { pattern: /\b(russian|tieng nga)\b/i, code: "rus" },
  { pattern: /\b(thai|tieng thai)\b/i, code: "tha" },
  {
    pattern: /\b(indonesian|bahasa indonesia|tieng indonesia)\b/i,
    code: "ind",
  },
  { pattern: /\b(arabic|tieng arab)\b/i, code: "arb" },
  { pattern: /\b(dutch|nederlands|tieng ha lan)\b/i, code: "nld" },
  { pattern: /\b(polish|tieng ba lan)\b/i, code: "pol" },
  { pattern: /\b(turkish|turkce|tieng tho)\b/i, code: "tur" },
  { pattern: /\b(hindi|tieng hindi)\b/i, code: "hin" },
  { pattern: /\b(ukrainian|tieng ukraine)\b/i, code: "ukr" },
];

function normalizeForAliasMatch(text: string) {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

export function languageNameFromCode(code: string): string {
  const key = code.trim().toLowerCase();
  return ISO_LANGUAGE_NAMES[key] ?? key.toUpperCase();
}

export function toReplyLanguageInfo(code: string): ReplyLanguageInfo {
  const normalized = code.trim().toLowerCase();
  if (!normalized || normalized === "unknown" || normalized === "und") {
    return DEFAULT_LANGUAGE;
  }
  return { code: normalized, name: languageNameFromCode(normalized) };
}

export function parseExplicitLanguageRequest(
  text: string
): ReplyLanguageInfo | null {
  const normalized = normalizeForAliasMatch(text);
  if (!normalized) return null;

  const hasLanguageSwitchIntent =
    /\b(use|speak|answer|reply|respond|write|tra loi|tra loi bang|repondez|repondre|parlez|parler|ecrire|parla|responde|antworten|sprich|habla|escribe|rispondi|otvet|otvechai)\b/.test(
      normalized
    ) || /\b(in|en|bang|auf|por|em)\s+[a-z]/.test(normalized);

  if (!hasLanguageSwitchIntent) return null;

  for (const { pattern, code } of EXPLICIT_LANGUAGE_ALIASES) {
    if (pattern.test(normalized)) {
      return toReplyLanguageInfo(code);
    }
  }

  const inLangMatch = normalized.match(
    /\b(?:in|en|bang|auf|por|em)\s+([a-z][a-z\s-]{2,24})\b/
  );
  if (inLangMatch?.[1]) {
    for (const { pattern, code } of EXPLICIT_LANGUAGE_ALIASES) {
      if (pattern.test(inLangMatch[1]!)) {
        return toReplyLanguageInfo(code);
      }
    }
  }

  return null;
}

function looksLikeAsciiDbPhrase(text: string) {
  const normalized = normalizeForAliasMatch(text);
  if (!normalized || !/^[\x00-\x7f]+$/.test(text.trim())) return false;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length > 6) return false;
  return (
    /\b(list|show)\b/.test(normalized) &&
    /\b(tables?|schemas?|databases?)\b/.test(normalized)
  );
}

const VIETNAMESE_HINT_WORDS =
  /\b(lay|cho|cac|bang|cot|dem|tim|hien thi|truy van|liet ke|du lieu|co so du lieu|voi|tu|den|trong|ngoai|khi|khong|duoc|hay|neu|thi|roi|nay|do|da|se|mot|bao nhieu|moi nhat|tat ca|toan bo|xin chao|cam on|cho toi|cau lenh|lenh sql|giup|ban ghi|ket qua|thong ke|loc|sap xep|so sanh|tong|trung binh)\b/;

/** Horned vowels and đ are strong Vietnamese signals (rare in French/English). */
function hasVietnameseLatinMarks(text: string) {
  return /[ăâđêôơưĂÂĐÊÔƠƯ]/.test(text);
}

function looksLikeVietnamesePhrase(text: string) {
  const normalized = normalizeForAliasMatch(text);
  if (/[đĐ]/.test(text) || hasVietnameseLatinMarks(text)) return true;
  return VIETNAMESE_HINT_WORDS.test(normalized);
}

function detectFromScript(text: string): ReplyLanguageInfo | null {
  if (/[\u3040-\u30ff]/.test(text)) {
    return toReplyLanguageInfo("jpn");
  }
  if (/[\uac00-\ud7af]/.test(text)) {
    return toReplyLanguageInfo("kor");
  }
  if (/[\u4e00-\u9fff]/.test(text)) {
    return toReplyLanguageInfo("cmn");
  }
  if (/[\u0600-\u06ff]/.test(text)) {
    return toReplyLanguageInfo("arb");
  }
  if (/[\u0400-\u04ff]/.test(text)) {
    return toReplyLanguageInfo("rus");
  }
  if (
    /[đĐ]/.test(text) ||
    /[ươă](?:̀|́|̣|̉|̃)|\b(?:xin chao|cam on|cho toi|liet ke|hien thi)\b/i.test(text)
  ) {
    return toReplyLanguageInfo("vie");
  }
  return null;
}

export function detectLanguageFromText(text: string): ReplyLanguageInfo {
  const raw = String(text ?? "").trim();
  if (!raw) return DEFAULT_LANGUAGE;

  const explicit = parseExplicitLanguageRequest(raw);
  if (explicit) return explicit;

  if (looksLikeVietnamesePhrase(raw)) {
    return toReplyLanguageInfo("vie");
  }

  if (looksLikeAsciiDbPhrase(raw)) {
    return DEFAULT_LANGUAGE;
  }

  const fromScript = detectFromScript(raw);
  if (fromScript) return fromScript;

  const detected = franc(raw, { minLength: 3 });
  if (detected && detected !== "und") {
    if (looksLikeVietnamesePhrase(raw)) {
      return toReplyLanguageInfo("vie");
    }
    if (
      /^[\x00-\x7f]+$/.test(raw.trim()) &&
      raw.trim().length < 48 &&
      detected !== "eng" &&
      detected !== "sco"
    ) {
      return DEFAULT_LANGUAGE;
    }
    return toReplyLanguageInfo(detected);
  }

  return DEFAULT_LANGUAGE;
}

export function resolveReplyLanguage(
  question: string,
  history: Array<{ role: string; text?: string }> = []
): ReplyLanguageInfo {
  const explicit = parseExplicitLanguageRequest(question);
  if (explicit) return explicit;

  const fromQuestion = detectLanguageFromText(question);
  if (fromQuestion.code !== "eng" || question.trim().length >= 8) {
    if (question.trim().length >= 3) {
      return fromQuestion;
    }
  }

  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i]!;
    if (item.role !== "user") continue;
    const text = item.text ?? "";
    const fromHistoryExplicit = parseExplicitLanguageRequest(text);
    if (fromHistoryExplicit) return fromHistoryExplicit;
    const fromHistory = detectLanguageFromText(text);
    if (fromHistory.code !== "eng" || text.trim().length >= 8) {
      return fromHistory;
    }
  }

  return fromQuestion;
}

export function formatReplyLanguageForPrompt(lang: ReplyLanguageInfo) {
  return `${lang.name} — you MUST write every word of explanation and clarification in ${lang.name} only; never use any other language`;
}

export function supportsLocalizedFastPath(lang: ReplyLanguageInfo) {
  return LOCALIZED_FAST_PATH_CODES.has(lang.code);
}

export function detectQuestionLanguageCode(text: string): string {
  const info = detectLanguageFromText(text);
  if (!text.trim()) return "unknown";
  if (info.code === "eng" && text.trim().length < 8) {
    return "unknown";
  }
  return info.code;
}
