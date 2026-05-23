/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        dirty: "#fdf0bb",
        deleted: "#fbbdbd",
        selected: "#bedbff",
        new: "#dcfce7",
      },
    },
    fontFamily: {
      sans: [
        "-apple-system",
        "BlinkMacSystemFont",
        "SF Pro Text",
        "SF Pro Display",
        "Inter",
        "system-ui",
        "sans-serif",
      ],
      mono: [
        "JetBrains Mono",
        "ui-monospace",
        "SFMono-Regular",
        "Menlo",
        "monospace",
      ],
    },
  },
  plugins: [],
};
