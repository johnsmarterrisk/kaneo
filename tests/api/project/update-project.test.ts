import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// Regression guard for review finding 2 (fork/initiative-settings, round 1): the general
// settings page (name/slug/description/icon) must never be able to flip a project's
// visibility, because it saves against a query snapshot that can be stale relative to a
// visibility change made on the Visibility tab. The API-level fix is that `isPublic` is
// optional on update, and an update that omits it must leave the stored value untouched
// — never default it to false or anything else.

const mockSelect = vi.fn();
const mockUpdate = vi.fn();

vi.mock("../../../apps/api/src/database", () => ({
  default: {
    select: (...args: unknown[]) => mockSelect(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

import updateProject from "../../../apps/api/src/project/controllers/update-project";

function makeSelectMock(rows: unknown[]) {
  const chain: Record<string, Mock> = {
    from: vi.fn(() => chain),
    where: vi.fn(() => Promise.resolve(rows)),
  };
  return chain;
}

function makeUpdateMock(updatedRow: unknown) {
  const returning = vi.fn(() => Promise.resolve([updatedRow]));
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  return { set, where, returning };
}

const existingProject = {
  id: "project-1",
  workspaceId: "workspace-1",
  name: "Old name",
  slug: "OLD",
  description: "old description",
  icon: "Layout",
  isPublic: true,
};

describe("updateProject", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSelect.mockReturnValue(makeSelectMock([existingProject]));
  });

  it("leaves isPublic out of the SQL update when the caller omits it (general settings save)", async () => {
    const updateChain = makeUpdateMock({
      ...existingProject,
      name: "New name",
    });
    mockUpdate.mockReturnValue(updateChain);

    await updateProject(
      "project-1",
      "New name",
      "Layout",
      "OLD",
      "old description",
      undefined,
      "workspace-1",
    );

    // This is the assertion that fails without the fix: a `set()` that always included
    // `isPublic` (even `undefined`) would silently coerce a stored `true` toward `false`
    // once passed through Drizzle. `isPublic` must not be a key on the payload at all.
    expect(updateChain.set).toHaveBeenCalledWith({
      name: "New name",
      icon: "Layout",
      slug: "OLD",
      description: "old description",
    });
    expect(updateChain.set.mock.calls[0][0]).not.toHaveProperty("isPublic");
  });

  it("still updates isPublic when the caller sends it explicitly (visibility toggle)", async () => {
    const updateChain = makeUpdateMock({ ...existingProject, isPublic: false });
    mockUpdate.mockReturnValue(updateChain);

    await updateProject(
      "project-1",
      existingProject.name,
      existingProject.icon,
      existingProject.slug,
      existingProject.description ?? "",
      false,
      "workspace-1",
    );

    expect(updateChain.set).toHaveBeenCalledWith({
      name: existingProject.name,
      icon: existingProject.icon,
      slug: existingProject.slug,
      description: existingProject.description,
      isPublic: false,
    });
  });

  it("does not update a project outside the authorized workspace", async () => {
    mockSelect.mockReturnValue(makeSelectMock([]));

    await expect(
      updateProject(
        "project-1",
        "New name",
        "Layout",
        "OLD",
        "old description",
        undefined,
        "other-workspace",
      ),
    ).rejects.toBeInstanceOf(HTTPException);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
