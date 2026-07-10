import { Link } from "@tanstack/react-router"

import { cn } from "@/lib/utils"
import logo from "/assets/images/plains-logo.png"

interface LogoProps {
  variant?: "full" | "icon" | "responsive"
  className?: string
  asLink?: boolean
  fillSpace?: boolean
}

export function Logo({
  variant = "full",
  className,
  asLink = true,
  fillSpace = false,
}: LogoProps) {
  const content = fillSpace ? (
    // #f9fafa is the logo PNG's own canvas colour; anything else seams at its edge.
    <div className="flex h-full w-full items-center justify-center bg-[#f9fafa]">
      <img
        src={logo}
        alt="Plains"
        className="h-auto w-auto max-h-full max-w-full object-contain p-8"
      />
    </div>
  ) : (
    <img
      src={logo}
      alt="Plains"
      className={cn(variant === "full" ? "h-16 w-auto" : "size-8", className)}
    />
  )

  if (!asLink) {
    return content
  }

  return <Link to="/">{content}</Link>
}
