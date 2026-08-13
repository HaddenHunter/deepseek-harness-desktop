/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        dsh: {
          bg: "#0b0d12",
          panel: "#121620",
          panel2: "#181d2b",
          border: "#262c3d",
          accent: "#6c8cff",
          accent2: "#36d399",
          warn: "#f59e0b",
          danger: "#ef4444",
        },
      },
      fontFamily: {
        mono: [
          "JetBrains Mono",
          "SF Mono",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
