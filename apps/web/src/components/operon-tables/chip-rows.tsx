import { cn } from "@/lib/cn";

/**
 * Operon fork addition (Tables task 8, docs/fork-discipline.md row 18, spec 7.10): the
 * filter chip rows — one per choice column (Status first) plus "Year:". One option per row
 * at a time; choosing the selected chip again clears it. The selection is sent to the rows
 * route, which filters before paging.
 */
export type ChipRow = {
  key: string;
  label: string;
  options: string[];
  selected: string | null;
  disabled?: boolean;
};

export default function ChipRows({
  rows,
  onSelect,
  inline = false,
}: {
  rows: ChipRow[];
  onSelect: (key: string, option: string | null) => void;
  /** Task 15 (spec 7.11): the phone's single chip row — every option, no row labels. */
  inline?: boolean;
}) {
  if (inline) {
    return (
      <fieldset
        aria-label="Filters"
        data-testid="chip-row-inline"
        className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0"
      >
        {rows.flatMap((row) =>
          row.options.map((option) => {
            const active = row.selected === option;
            return (
              <button
                key={`${row.key}:${option}`}
                type="button"
                aria-pressed={active}
                disabled={row.disabled}
                onClick={() => onSelect(row.key, active ? null : option)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-card-foreground hover:bg-accent/60",
                  row.disabled && "cursor-not-allowed opacity-50",
                )}
              >
                {option}
              </button>
            );
          }),
        )}
      </fieldset>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <fieldset
          key={row.key}
          className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0"
          aria-label={row.label}
        >
          <span className="text-xs font-medium text-muted-foreground">
            {row.label}:
          </span>
          {row.options.map((option) => {
            const active = row.selected === option;
            return (
              <button
                key={option}
                type="button"
                aria-pressed={active}
                disabled={row.disabled}
                onClick={() => onSelect(row.key, active ? null : option)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-card-foreground hover:bg-accent/60",
                  row.disabled && "cursor-not-allowed opacity-50",
                )}
              >
                {option}
              </button>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
