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
          popup.style.top = `${rect.bottom + window.scrollY + 4}px`;
          popup.style.left = `${rect.left + window.scrollX}px`;
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
          },
          onUpdate: (props) => {
            component?.updateProps(props);
            place(props.clientRect);
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
