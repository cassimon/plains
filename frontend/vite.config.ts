import fs from "node:fs"
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react-swc"
import { defineConfig } from "vite"

function getRootEnvironment(): string | undefined {
  try {
    const content = fs.readFileSync(path.resolve(__dirname, "../.env"), "utf8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.startsWith("#") || !trimmed.includes("=")) continue
      const [key, ...rest] = trimmed.split("=")
      if (key.trim() === "ENVIRONMENT") return rest.join("=").trim()
    }
  } catch {
    // no root .env — fall through
  }
}

const isDev = getRootEnvironment() === "dev"
const basePath = isDev ? "/" : process.env.VITE_BASE_PATH || "/"

// https://vitejs.dev/config/
export default defineConfig({
  base: basePath,
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
})
