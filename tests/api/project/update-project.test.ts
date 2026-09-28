import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// Regression guard for review finding 2 (fork/initiative-settings, round 1): the general
// settings page (name/slug/description/icon) must never be able to flip a project's
// visibility, because it saves against a query snapshot that can be stale relative to a
// visibility change made on the Visibility tab. The API-level fix is that `isPublic` is
// optional on update, and an update that omits it must leave the stored value untouched
// — never default it to false or anything else.
//
// Regression guard for review finding A (fork/initiative-settings, round 2): the mirror
// image bug — a visibility toggle must never be able to revert a concurrent general edit
// (rename, key change, etc), because it saves against a query snapshot that can be stale
// relative to an edit made on the General tab. The fix extends the same optional-field
// pattern to name/icon/slug/description, so every field on this route is optional and an
// omitted field leaves the stored value untouched.

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

  it("leaves name/icon/slug/description out of the SQL update when the caller sends only isPublic (visibility toggle payload)", async () => {
    const updateChain = makeUpdateMock({ ...existingProject, isPublic: false });
    mockUpdate.mockReturnValue(updateChain);

    await updateProject(
      "project-1",
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      "workspace-1",
    );

    // This is the assertion that fails without the fix: a visibility toggle that sent a
    // name/icon/slug/description snapshot back (the bug this route now guards against)
    // would silently revert a concurrent general-settings edit.
    expect(updateChain.set).toHaveBeenCalledWith({ isPublic: false });
  });

  describe.each([
    ["name", "New name"],
    ["icon", "Rocket"],
    ["slug", "NEW"],
    ["description", "new description"],
  ] as const)("%s field", (field, newValue) => {
    it("is left out of the SQL update when the caller omits it", async () => {
      const updateChain = makeUpdateMock({
        ...existingProject,
        isPublic: false,
      });
      mockUpdate.mockReturnValue(updateChain);

      const args: Record<string, string | boolean | undefined> = {
        name: undefined,
        icon: undefined,
        slug: undefined,
        description: undefined,
        isPublic: false,
      };

      await updateProject(
        "project-1",
        args.name as string | undefined,
        args.icon as string | undefined,
        args.slug as string | undefined,
        args.description as string | undefined,
        args.isPublic as boolean | undefined,
        "workspace-1",
      );

      expect(updateChain.set.mock.calls[0][0]).not.toHaveProperty(field);
    });

    it("is written to the SQL update when the caller sends it", async () => {
      const updateChain = makeUpdateMock({
        ...existingProject,
        [field]: newValue,
      });
      mockUpdate.mockReturnValue(updateChain);

      const args: Record<string, string | boolean | undefined> = {
        name: undefined,
        icon: undefined,
        slug: undefined,
        description: undefined,
        isPublic: undefined,
      };
      args[field] = newValue;

      await updateProject(
        "project-1",
        args.name as string | undefined,
        args.icon as string | undefined,
        args.slug as string | undefined,
        args.description as string | undefined,
        args.isPublic as boolean | undefined,
        "workspace-1",
      );

      expect(updateChain.set).toHaveBeenCalledWith({ [field]: newValue });
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
