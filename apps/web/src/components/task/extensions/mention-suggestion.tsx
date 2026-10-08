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
 * Where the popup goes (Operon fork, open-items row 390): below the caret when it fits,
 * otherwise above it when there is more room there, and never past the window's left or
 * right edge. Viewport coordinates in, page coordinates out (the popup is body-absolute).
 * `popup.height` is the list's full (uncapped) height; `maxHeight` is the room on the chosen
 * side, which the caller sets as the list's cap in place of the stylesheet's fixed 16rem —
 * that fixed cap hid the last rows (the group row) inside the list even after the flip
 * (2026-10-08). The list holds at most 8 people and 3 groups, so the room is the only cap.
 */
export function mentionPopupPosition(
  caret: { top: number; bottom: number; left: number },
  popup: { width: number; height: number },
  view: { width: number; height: number; scrollX: number; scrollY: number },
): { top: number; left: number; maxHeight: number } {
  const gap = 4;
  const margin = 8;
  const spaceBelow = view.height - caret.bottom - gap - margin;
  const spaceAbove = caret.top - gap - margin;
  const flip = popup.height > spaceBelow && spaceAbove > spaceBelow;
  const maxHeight = Math.max(0, flip ? spaceAbove : spaceBelow);
  const height = Math.min(popup.height, maxHeight);
  const top = flip
    ? Math.max(margin, caret.top - gap - height)
    : caret.bottom + gap;
  const left = Math.max(
    margin,
    Math.min(caret.left, view.width - popup.width - margin),
  );
  return { top: top + view.scrollY, left: left + view.scrollX, maxHeight };
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
          if (!popup || !clientRect) return;
          const rect = clientRect();
          if (!rect) return;
          // Measure the list's full height (scrollHeight plus its border), not the capped box.
          const list = popup.querySelector<HTMLElement>(".kaneo-mention-list");
          const height = list
            ? list.scrollHeight + (list.offsetHeight - list.clientHeight)
            : popup.offsetHeight;
          const { top, left, maxHeight } = mentionPopupPosition(
            rect,
            { width: popup.offsetWidth, height },
            {
              width: document.documentElement.clientWidth,
              height: window.innerHeight,
              scrollX: window.scrollX,
              scrollY: window.scrollY,
            },
          );
          if (list) list.style.maxHeight = `${maxHeight}px`;
          popup.style.top = `${top}px`;
          popup.style.left = `${left}px`;
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
