import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./pages/**/*.{js,ts,jsx,tsx,mdx}", "./components/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        background: "#111310",
        foreground: "#f3f4ef",
        primary: "#cfefa5",
        secondary: "#64748b",
        brand: {
          ink: "#111310",
          foreground: "#f3f4ef",
          cyan: "#cfefa5",
          gold: "#e5d8a7",
          orange: "#edaa86",
        },
      },
    },
  },
  plugins: [],
};

export default config;
