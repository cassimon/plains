interface PageHeaderProps {
  title: string
  description?: string
}

/** Page title + optional description, used by the shadcn/Tailwind administration
 *  area (`_layout`). Keeps the heading hierarchy consistent with the rest of the
 *  area without a heavier abstraction. */
export function PageHeader({ title, description }: PageHeaderProps) {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      {description ? (
        <p className="text-muted-foreground">{description}</p>
      ) : null}
    </div>
  )
}
