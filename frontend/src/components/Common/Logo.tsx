import { Link } from "@tanstack/react-router"

import { cn } from "@/lib/utils"
import logo from "/assets/images/plains-logo.png"

interface LogoProps {
  variant?: "full" | "icon" | "responsive"
  className?: string
  asLink?: boolean
}

export function Logo({
  variant = "full",
  className,
  asLink = true,
}: LogoProps) {
  const content = (
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
