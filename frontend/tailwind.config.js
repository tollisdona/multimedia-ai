/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        soft: "0 18px 70px rgba(15, 23, 42, 0.08)",
      },
      keyframes: {
        "sound-wave": {
          "0%, 100%": { transform: "scaleY(0.35)" },
          "50%": { transform: "scaleY(1)" },
        },
      },
      animation: {
        "sound-wave": "sound-wave 720ms ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
