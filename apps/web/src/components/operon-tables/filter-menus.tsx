import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { cn } from "@/lib/cn";

/**
 * Operon fork addition (Tables filter bar, docs/fork-discipline.md row 18, spec
 * tables-filter-bar §7.1): one dropdown menu per choice column, several options ticked per
 * column (OR within a column, AND across columns — the rows route applies them). Replaces
 * the chip rows. The button shows the chosen values in option order, never tick order, so
 * the label does not reshuffle as the user ticks.
 */
export type FilterMenu = {
  key: string;
  label: string;
  options: string[];
  selected: string[];
};

function menuLabel(label: string, selected: string[]) {
  if (selected.length === 0) return label;
  const more = selected.length > 2 ? ` +${selected.length - 2}` : "";
  return `${label}: ${selected.slice(0, 2).join(", ")}${more}`;
}

export default function FilterMenus({
  menus,
  onChange,
  onClearAll,
}: {
  /** Already ordered and already minus the hidden group column. */
  menus: FilterMenu[];
  /** `selected` in option order; [] clears the column. */
  onChange: (key: string, selected: string[]) => void;
  onClearAll: () => void;
}) {
  if (menus.length === 0) return null;
  const anyChosen = menus.some((m) => m.selected.length > 0);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {menus.map((menu) => {
        const visible = menuLabel(menu.label, menu.selected);
        // WCAG 2.5.3: the visible text stays in the name; past two values the "+n" hides
        // the rest, so the name also lists every selected option.
        const name =
          menu.selected.length > 2
            ? `${visible} (selected: ${menu.selected.join(", ")})`
            : visible;
        return (
          <DropdownMenu key={menu.key}>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={name}
                  className={cn(
                    "inline-flex h-7 max-w-64 items-center gap-1.5 rounded-md border border-input bg-secondary px-2.5 text-card-foreground text-xs font-medium outline-none ring-0 [@media(hover:hover)]:hover:bg-accent/60",
                    menu.selected.length > 0 && "border-primary",
                  )}
                />
              }
            >
              <span className="truncate">{visible}</span>
              <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {menu.selected.length > 0 && (
                <>
                  <DropdownMenuItem onClick={() => onChange(menu.key, [])}>
                    Clear
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              {menu.options.map((option) => (
                <DropdownMenuCheckboxItem
                  key={option}
                  checked={menu.selected.includes(option)}
                  onCheckedChange={(on) =>
                    onChange(
                      menu.key,
                      menu.options.filter((o) =>
                        o === option ? on : menu.selected.includes(o),
                      ),
                    )
                  }
                >
                  {option}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
      {anyChosen && (
        // Its own flex child: full width on a phone so it takes the panel's last line.
        <div className="w-full md:w-auto">
          <button
            type="button"
            onClick={onClearAll}
            className="inline-flex h-7 items-center rounded-md px-2 text-left text-xs text-muted-foreground [@media(hover:hover)]:hover:bg-accent/60 [@media(hover:hover)]:hover:text-foreground"
          >
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}
