import { Generator, getConfig } from "@tanstack/router-generator"

const config = getConfig(
  {
    target: "react",
    autoCodeSplitting: true,
    routeFileIgnorePattern: "\\.page\\.tsx$",
  },
  process.cwd(),
)

const generator = new Generator({
  config,
  root: process.cwd(),
})

try {
  await generator.run()
  console.log("TanStack route tree generated")
} catch (error) {
  console.error("Failed to generate TanStack route tree")
  console.error(error)
  process.exit(1)
}
