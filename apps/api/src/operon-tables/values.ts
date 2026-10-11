import { HTTPException } from "hono/http-exception";
import { validateCustomFieldValue } from "../task/validate-task-fields";
import { normalizeStashFileId } from "./stash-image";

/**
 * Operon fork addition (Tables task 5, docs/fork-discipline.md row 18, spec 7.1 / 7.3): the
 * conversion between a table's typed JSON values (what REST and the MCP send) and #1542's
 * stored text, plus the structured 422s. #1542's validator messages echo the rejected value,
 * so they are never forwarded: every refusal here names the column, never the value (R-H).
 */
export type ColumnDef = {
  id: string;
  name: string;
  type: string;
  required: boolean;
  options: unknown;
  position: number;
};

export const TEXT_MAX_LENGTH = 2000;
export const TITLE_MAX_LENGTH = 500;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function tableError(
  status: 400 | 403 | 404 | 409 | 422 | 503,
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  throw new HTTPException(status, {
    res: Response.json({ error, message, ...extra }, { status }),
  });
}

export function optionList(def: ColumnDef): string[] {
  return Array.isArray(def.options)
    ? (def.options as unknown[]).filter(
        (o): o is string => typeof o === "string",
      )
    : [];
}

function fold(name: string) {
  return name.trim().toLowerCase();
}

/** A `values` key is a column id, or an active column's name matched case-insensitively. */
export function resolveColumn(
  defs: ColumnDef[],
  key: string,
): ColumnDef | undefined {
  return (
    defs.find((d) => d.id === key) ??
    defs.find((d) => fold(d.name) === fold(key))
  );
}

export function unknownColumn(defs: ColumnDef[]): never {
  tableError(422, "unknown_column", "That column is not in this table", {
    columns: defs.map((d) => d.name),
  });
}

export function unknownOption(def: ColumnDef): never {
  tableError(422, "unknown_option", "That option is not in this column", {
    column: def.name,
    options: optionList(def),
  });
}

function invalidValue(def: ColumnDef): never {
  tableError(422, "invalid_value", "That value does not fit this column", {
    column: def.name,
    kind: def.type,
  });
}

/**
 * Typed input → #1542's stored text (`null` = clear). Image values are only shape-checked
 * here; the Stash check (async, over the signed channel) is the caller's.
 */
export function toStoredText(def: ColumnDef, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  switch (def.type) {
    case "text": {
      if (typeof value !== "string") invalidValue(def);
      const text = value.trim();
      if (text.length > TEXT_MAX_LENGTH) invalidValue(def);
      return text === "" ? null : text;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value))
        invalidValue(def);
      return String(value);
    }
    case "boolean": {
      if (typeof value !== "boolean") invalidValue(def);
      return value ? "true" : "false";
    }
    case "date": {
      if (typeof value !== "string") invalidValue(def);
      const date = value.trim();
      if (date === "") return null;
      if (
        !DATE_ONLY.test(date) ||
        validateCustomFieldValue(date, "date", def.name)
      )
        invalidValue(def);
      return date;
    }
    case "dropdown": {
      if (typeof value !== "string") invalidValue(def);
      const label = value.trim();
      if (label === "") return null;
      if (!optionList(def).includes(label)) unknownOption(def);
      return label;
    }
    case "multiselect": {
      if (!Array.isArray(value)) invalidValue(def);
      if (value.length === 0) return null;
      const options = optionList(def);
      const picked: string[] = [];
      for (const entry of value) {
        if (typeof entry !== "string") invalidValue(def);
        const label = entry.trim();
        if (!options.includes(label)) unknownOption(def);
        if (!picked.includes(label)) picked.push(label);
      }
      return JSON.stringify(picked);
    }
    case "link": {
      if (typeof value !== "string") invalidValue(def);
      const url = value.trim();
      if (url === "") return null;
      if (validateCustomFieldValue(url, "link", def.name)) invalidValue(def);
      return url;
    }
    case "image": {
      if (typeof value !== "string") invalidValue(def);
      if (value.trim() === "") return null;
      const fileId = normalizeStashFileId(value);
      if (!fileId)
        tableError(422, "image_refused", "That image cannot be used", {
          column: def.name,
          reason: "not_a_stash_file",
        });
      return fileId;
    }
    default:
      invalidValue(def);
  }
}

/** Stored text → the typed JSON a table read answers with. */
export function fromStoredText(def: ColumnDef, text: string | null): unknown {
  if (text === null || text === undefined || text === "") return null;
  switch (def.type) {
    case "number":
      return Number(text);
    case "boolean":
      return text === "true";
    case "multiselect":
      try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    default:
      return text;
  }
}

/** Stored text → the display text a `fields_changed` record carries (spec 7.3 step 6). */
export function displayValue(def: ColumnDef, text: string | null) {
  if (text === null || text === "") return null;
  if (def.type === "boolean") return text === "true" ? "Yes" : "No";
  if (def.type === "multiselect") {
    const parsed = fromStoredText(def, text) as string[];
    return parsed.join(", ");
  }
  return text;
}

/** Cap at `max` code points INCLUDING a trailing ellipsis when truncated (spec 7.3 step 6). */
export function capCodePoints(value: string, max: number) {
  const points = Array.from(value);
  if (points.length <= max) return value;
  return `${points.slice(0, max - 1).join("")}…`;
}
