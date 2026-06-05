import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react-swc"
import { defineConfig } from "vite"

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  const isDev = command === "serve"
  
  // In dev mode: serve at root with direct backend access
  // In build mode: use /plains/ base path for deployment
  const base = isDev ? "/" : (process.env.VITE_BASE_PATH || "/")
  
  return {
    base,
    server: isDev
      ? {
          port: 5173,
          strictPort: true,
          open: "/login",
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
