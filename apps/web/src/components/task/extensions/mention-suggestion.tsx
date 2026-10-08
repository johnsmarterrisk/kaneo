import { computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion";
import MentionList, {
  type MentionListRef,
  type MentionMember,
} from "./mention-list";

/** Operon fork (group mentions D10): a group item also matches on its name. */
export type MentionGroup = MentionMember & { name: string };

type MentionSuggestionOptions = {
  getMembers: () => MentionMember[];
  getGroups: () => MentionGroup[];
};

/**
 * The list for a query: the first 8 matching people, as upstream, then up to 3 matching
 * groups (Operon fork, group mentions D10) — people always come first.
 */
export function mentionSuggestionItems(
  query: string,
  members: MentionMember[],
  groups: MentionGroup[],
): MentionMember[] {
  const q = query.toLowerCase();
  const people = members
    .filter((m) => m.label?.toLowerCase().includes(q))
    .slice(0, 8);
  const matchedGroups = groups
    .filter(
      (g) =>
        g.label.toLowerCase().includes(q) || g.name.toLowerCase().includes(q),
    )
    .slice(0, 3);
  return [...people, ...matchedGroups];
}

/**
 * Operon's groups as mention items: `group:<slug>`, labelled with the slug (what the
 * mention renders, `@slug`), counting only members with an Initiative account, and a
 * hover text when some members have none (they get Telegraph alerts only, D10).
 */
export function operonGroupMentionItems(
  groups: {
    slug: string;
    name: string;
    initiativeCount: number;
    memberCount: number;
  }[],
): MentionGroup[] {
  return groups.map((group) => ({
    id: `group:${group.slug}`,
    label: group.slug,
    name: group.name,
    image: null,
    secondary: `group · ${group.initiativeCount} ${
      group.initiativeCount === 1 ? "person" : "people"
    }`,
    ...(group.initiativeCount < group.memberCount
      ? {
          title: `${group.initiativeCount} of ${group.memberCount} in this group use Initiative`,
        }
      : {}),
  }));
}

/**
 * Places the popup at the caret (Operon fork, open-items row 390): below it when the list
 * fits, otherwise above it when there is more room there, and never past the window's edges;
 * the list's height is capped at the room on the side it opens, in place of the stylesheet's
 * fixed 16rem, which hid the last rows (the group row) inside the list even after the flip.
 * Placement and sizing are `@floating-ui/dom`'s `flip`, `size` and `shift` middleware (a
 * direct dependency for this, MIT; Codex round 1, 2026-10-08) — not hand-written geometry.
 * The cap is cleared before measuring so `flip` sees the list's full height: the list holds
 * at most 8 people and 3 groups, so the room is the only cap.
 */
export async function placeMentionPopup(
  caretRect: () => DOMRect,
  popup: HTMLElement,
): Promise<void> {
  const list = popup.querySelector<HTMLElement>(".kaneo-mention-list");
  if (list) list.style.maxHeight = "none";
  const { x, y } = await computePosition(
    { getBoundingClientRect: caretRect },
    popup,
    {
      placement: "bottom-start",
      strategy: "absolute",
      middleware: [
        offset(4),
        flip({ padding: 8 }),
        size({
          padding: 8,
          apply({ availableHeight }) {
            if (list)
              list.style.maxHeight = `${Math.max(0, availableHeight)}px`;
          },
        }),
        shift({ padding: 8 }),
      ],
    },
  );
  popup.style.top = `${y}px`;
  popup.style.left = `${x}px`;
}

// Adds an @-triggered autocomplete of workspace members to an editor. On select
// it inserts a `kaneoMention` node (which round-trips through Markdown). Built on
// @tiptap/suggestion so it stays self-contained and does not touch the editor's
// own keyboard/menu handling.
export const MentionSuggestion = Extension.create<MentionSuggestionOptions>({
  name: "kaneoMentionSuggestion",

  addOptions() {
    return { getMembers: () => [], getGroups: () => [] };
  },

  addProseMirrorPlugins() {
    const getMembers = this.options.getMembers;
    const getGroups = this.options.getGroups;

    const suggestion: Omit<SuggestionOptions, "editor"> = {
      char: "@",
      pluginKey: new PluginKey("kaneoMentionSuggestion"),
      allowSpaces: false,
      items: ({ query }) =>
        mentionSuggestionItems(query, getMembers(), getGroups()),
      command: ({ editor, range, props }) => {
        const member = props as unknown as MentionMember;
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            {
              type: "kaneoMention",
              attrs: { id: member.id, label: member.label },
            },
            { type: "text", text: " " },
          ])
          .run();
      },
      render: () => {
        let component: ReactRenderer<MentionListRef> | null = null;
        let popup: HTMLDivElement | null = null;

        const place = (clientRect?: (() => DOMRect | null) | null) => {
          const target = popup;
          if (!target || !clientRect) return;
          const rect = clientRect();
          if (!rect) return;
          placeMentionPopup(() => clientRect() ?? rect, target).catch(
            (error: unknown) => {
              console.error("mention popup placement failed", error);
            },
          );
        };

        return {
          onStart: (props) => {
            component = new ReactRenderer(MentionList, {
              props,
              editor: props.editor,
            });
            popup = document.createElement("div");
            popup.className = "kaneo-mention-popup";
            popup.appendChild(component.element);
            document.body.appendChild(popup);
            place(props.clientRect);
            // The list may draw after this call; place again once it has a height.
            requestAnimationFrame(() => place(props.clientRect));
          },
          onUpdate: (props) => {
            component?.updateProps(props);
            place(props.clientRect);
            requestAnimationFrame(() => place(props.clientRect));
          },
          onKeyDown: (props) => {
            if (props.event.key === "Escape") return false;
            return component?.ref?.onKeyDown(props) ?? false;
          },
          onExit: () => {
            popup?.remove();
            popup = null;
            component?.destroy();
            component = null;
          },
        };
      },
    };

    return [Suggestion({ editor: this.editor, ...suggestion })];
  },
});
