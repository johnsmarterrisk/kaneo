import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CommentInput from "./comment-input";

/**
 * comment-input.tsx — Stage 1 round-1 finding 6's own assertion: a non-empty draft must
 * register itself as protected state (`registerDirtyEditor`, `@/lib/version-check`) so a
 * version-mismatch reload defers rather than discarding an unsent comment — the same
 * contract `app/src/shell/telegraph/__tests__/MessageComposer.protectedState.test.tsx`
 * proves on the Operon side for the channel/thread composer.
 *
 * `CommentEditor` is a full tiptap rich-text editor — mocked here to a plain `<textarea>`
 * exposing the same `value`/`onChange` contract `comment-input.tsx` actually depends on,
 * so this file tests comment-input's OWN logic (draft tracking, dirty registration, submit)
 * rather than re-testing tiptap.
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/activity/comment-editor", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="comment-editor-stub"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

const createCommentMock = vi.fn(async () => ({}));
vi.mock("@/hooks/mutations/comment/use-create-comment", () => ({
  default: () => ({ mutateAsync: createCommentMock, isPending: false }),
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const registered = vi.hoisted(() => ({
  check: null as (() => boolean) | null,
  unregister: vi.fn(),
}));
vi.mock("@/lib/version-check", () => ({
  registerDirtyEditor: (check: () => boolean) => {
    registered.check = check;
    return registered.unregister;
  },
}));

afterEach(() => {
  cleanup();
  registered.check = null;
  registered.unregister.mockClear();
  createCommentMock.mockClear();
});

function mount() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <CommentInput taskId="task-1" />
    </QueryClientProvider>,
  );
}

describe("CommentInput registers a dirty-editor predicate (finding 6)", () => {
  it("registers on mount, and the predicate reads false while the draft is empty", () => {
    mount();
    expect(registered.check).not.toBeNull();
    expect(registered.check?.()).toBe(false);
  });

  it("the predicate reads true once the draft is non-empty — reads FRESH, not a mount-time snapshot", () => {
    mount();
    const editor = screen.getByLabelText("comment-editor-stub");
    fireEvent.change(editor, { target: { value: "a draft nobody sent yet" } });
    expect(registered.check?.()).toBe(true);
  });

  it("the predicate reads false again once cleared to whitespace-only", () => {
    mount();
    const editor = screen.getByLabelText("comment-editor-stub");
    fireEvent.change(editor, { target: { value: "hello" } });
    expect(registered.check?.()).toBe(true);
    fireEvent.change(editor, { target: { value: "   " } });
    expect(registered.check?.()).toBe(false);
  });

  it("unregisters on unmount", () => {
    const { unmount } = mount();
    expect(registered.unregister).not.toHaveBeenCalled();
    unmount();
    expect(registered.unregister).toHaveBeenCalledTimes(1);
  });
});
