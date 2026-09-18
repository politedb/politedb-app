import { invoke } from "@tauri-apps/api/core";
import { CMD } from "./commands";
import type { SnippetLibrary } from "src/lib/snippets/types";
import { emptySnippetLibrary } from "src/lib/snippets/types";
import { parseSnippetLibrary } from "src/lib/snippets/library";

export async function loadSnippetLibrary(): Promise<SnippetLibrary> {
  try {
    const raw = await invoke<unknown>(CMD.snippetsLoad);
    return parseSnippetLibrary(raw);
  } catch (err) {
    console.warn("[snippets] load failed:", err);
    return emptySnippetLibrary();
  }
}

export async function saveSnippetLibrary(
  library: SnippetLibrary
): Promise<void> {
  try {
    await invoke<void>(CMD.snippetsSave, { library });
  } catch (err) {
    console.warn("[snippets] save failed:", err);
    throw err;
  }
}
