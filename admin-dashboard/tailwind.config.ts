import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./pages/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
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
