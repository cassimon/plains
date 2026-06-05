import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react-swc"
import { defineConfig } from "vite"

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  const devOpenUrl =
    process.env.VITE_DEV_OPEN_URL || "http://localhost:81/plains/login"

  return {
    base: process.env.VITE_BASE_PATH || "/",
    server:
      command === "serve"
        ? {
            open: devOpenUrl,
          }
        : undefined,
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    plugins: [
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        routeFileIgnorePattern: "\\.page\\.tsx$",
      }),
      react(),
      tailwindcss(),
    ],
  }
})
