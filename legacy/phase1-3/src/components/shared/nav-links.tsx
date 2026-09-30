"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";
import type { NavItem } from "@/config/navigation";

export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  // The most specific matching item is active (so "/admin" is not active on "/admin/x" when "/admin/x" exists).
  const active = items
    .filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];

  return (
    <nav className="flex gap-1 md:flex-col" aria-label="Main">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={item === active ? "page" : undefined}
          className={cn(
            "rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            item === active && "bg-muted text-foreground",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
