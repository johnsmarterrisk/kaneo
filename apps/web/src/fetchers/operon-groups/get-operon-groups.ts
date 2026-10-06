import { getApiUrl } from "@/fetchers/get-api-url";

/**
 * One of Operon's people groups as Initiative's mention list shows it (Operon
 * group-mentions spec D10). `initiativeCount` is how many of the group's `memberCount`
 * people have an Initiative account; only they can be notified here. Member ids never
 * reach the browser.
 */
export type OperonGroupItem = {
  slug: string;
  name: string;
  initiativeCount: number;
  memberCount: number;
};

async function getOperonGroups(): Promise<OperonGroupItem[]> {
  const response = await fetch(getApiUrl("/operon/groups"), {
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(`Operon groups could not be read (${response.status})`);
  }

  const body = (await response.json()) as { groups?: unknown };
  return Array.isArray(body.groups) ? (body.groups as OperonGroupItem[]) : [];
}

export default getOperonGroups;
