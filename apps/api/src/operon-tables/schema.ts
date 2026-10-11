/**
 * Operon fork addition (Tables, docs/fork-discipline.md row 18, spec 7.2): the "New table"
 * template — the Marketing asset columns. Title and Notes are the task's own fields and Made
 * by is system-set, so they are not definitions. The first three set the table's group,
 * status and date columns.
 */
export const TABLE_TEMPLATE_COLUMNS = [
  { key: "topic", name: "Topic", type: "dropdown", options: [] as string[] },
  {
    key: "status",
    name: "Status",
    type: "dropdown",
    options: ["Idea", "In progress", "Published"],
  },
  { key: "posted", name: "Posted", type: "date", options: null },
  {
    key: "channel",
    name: "Channel",
    type: "dropdown",
    options: ["LinkedIn", "Newsletter", "Site"],
  },
  { key: "link", name: "Link", type: "link", options: null },
] as const;

export const TABLE_DEFAULT_ICON = "Layout";
