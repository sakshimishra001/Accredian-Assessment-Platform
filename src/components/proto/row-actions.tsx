"use client";

import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export interface RowAction {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

/** "⋯" menu for table rows. */
export function RowActions({ actions, label = "Actions" }: { actions: RowAction[]; label?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={(e) => e.stopPropagation()}
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {actions.map((a) => (
          <div key={a.label}>
            {a.separatorBefore ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem variant={a.destructive ? "destructive" : "default"} disabled={a.disabled} onClick={a.onSelect}>
              {a.icon ? <a.icon /> : null}
              {a.label}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
