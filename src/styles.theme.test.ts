import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
const leftNav = readFileSync(
  resolve(process.cwd(), "src/screens/main/LeftNav.tsx"),
  "utf8"
);
const header = readFileSync(
  resolve(process.cwd(), "src/components/AppHeader.tsx"),
  "utf8"
);
const searchNav = readFileSync(
  resolve(process.cwd(), "src/screens/connection/LeftNav.tsx"),
  "utf8"
);

describe("global dark theme remaps", () => {
  it("inverts page canvases that use bg-neutral-100", () => {
    expect(css).toContain("html.dark .bg-neutral-100");
  });

  it("inverts favorite/alert pastels so they do not stay light", () => {
    expect(css).toContain("html.dark .bg-amber-50\\/40");
    expect(css).toContain("html.dark .bg-blue-50");
    expect(css).toContain("html.dark .bg-rose-50");
    expect(css).toContain("html.dark .bg-emerald-50");
  });

  it("inverts remaining light text and borders", () => {
    expect(css).toContain("html.dark .text-neutral-800");
    expect(css).toContain("html.dark .text-neutral-400");
    expect(css).toContain("html.dark .border-neutral-100");
  });

  it("inverts translucent white surfaces used by tips and empty states", () => {
    expect(css).toContain("html.dark .bg-white\\/60");
    expect(css).toContain("html.dark .hover\\:bg-neutral-300\\/80:hover");
  });

  it("inverts important white inputs and pastel blue chips", () => {
    expect(css).toContain("html.dark .bg-white\\!");
    expect(css).toContain("html.dark .focus\\:bg-white:focus");
    expect(css).toContain("html.dark .bg-blue-100");
    expect(css).toContain("html.dark .bg-rose-50\\/80");
  });

  it("uses the Codex charcoal surface hierarchy", () => {
    expect(css).toContain("background: #181818");
    expect(css).toContain("--color-slate-950: #181818");
    expect(css).toContain("--color-slate-900: #242424");
    expect(css).toContain("html.dark aside");
    expect(css).toContain("background-color: #212121 !important");
  });
});

describe("remaining dark-theme spots", () => {
  it("keeps sponsor readable on a dark rose surface", () => {
    expect(leftNav).toContain("dark:text-rose-300");
    expect(leftNav).toContain("dark:bg-rose-950/50");
  });

  it("uses a Cursor-like Databases chip in dark mode", () => {
    expect(header).toContain("dark:bg-white/10");
    expect(header).toContain("dark:text-zinc-100");
  });

  it("does not force the table search input to stay white", () => {
    expect(searchNav).not.toContain("bg-white!");
    expect(searchNav).toContain("bg-white");
  });
});
