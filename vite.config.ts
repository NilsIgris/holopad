import { defineConfig } from "vite";

// Configuration adaptée à Tauri : port fixe, pas d'effacement de la console.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome120",
    outDir: "dist",
    sourcemap: false,
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
