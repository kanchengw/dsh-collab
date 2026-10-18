import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { composerKeyAction, composerMentionMenuKeyAction, composerMentionSuggestions, composerTargetForGesture, extractComposerMentionIds, insertMemberMention } from "./ui.js";
import type { DshCollabClientPort, DshCollabClientSnapshot } from "./dsh-client.js";
import type { CollabTranslate } from "./locales.js";
import css from "./collab-room.module.css";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function DshCollabComposer(props: {
  port: DshCollabClientPort;
  snapshot: DshCollabClientSnapshot;
  t: CollabTranslate;
}): ReactNode {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionOpen, setMentionOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCursor = useRef<number>();
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const target = composerTargetForGesture(draft, false, false);
  const mentionOptions = composerMentionSuggestions(draft, props.snapshot.members ?? [], selection.start, selection.end);
  const showMentions = mentionOpen && mentionOptions.length > 0;
  useIsomorphicLayoutEffect(() => {
    const cursor = pendingCursor.current;
    const textarea = textareaRef.current;
    if (cursor === undefined || !textarea) return;
    pendingCursor.current = undefined;
    textarea.focus();
    textarea.setSelectionRange(cursor, cursor);
    setSelection({ start: cursor, end: cursor });
  }, [draft]);
  const readSelection = (textarea = textareaRef.current): { start: number; end: number } => ({ start: textarea?.selectionStart ?? draft.length, end: textarea?.selectionEnd ?? draft.length });
  const applyMemberMention = (member: (typeof mentionOptions)[number], range: { start: number; end: number }): void => {
    const nextDraft = insertMemberMention(draft, member, range.start, range.end);
    pendingCursor.current = nextDraft.length - (draft.length - range.end);
    setDraft(nextDraft);
    setSelection({ start: pendingCursor.current, end: pendingCursor.current });
    setMentionOpen(false);
  };

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (text === "" || busy) return;
    setBusy(true);
    setError(false);
    try {
      await props.port.send({ text, target, mentions: extractComposerMentionIds(text, props.snapshot.members ?? []) });
      setDraft("");
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (showMentions) {
      const action = composerMentionMenuKeyAction({ key: event.key, selectedIndex: mentionIndex, optionCount: mentionOptions.length });
      if (action.kind === "move") { event.preventDefault(); setMentionIndex(action.selectedIndex); return; }
      if (action.kind === "select") { event.preventDefault(); applyMemberMention(mentionOptions[action.selectedIndex]!, readSelection(event.currentTarget)); return; }
      if (action.kind === "close") { event.preventDefault(); setMentionOpen(false); return; }
    }
    if (composerKeyAction({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, repeat: event.repeat }) !== "submit") return;
    event.preventDefault();
    void submit();
  };

  return (
    <form className={css.composer} data-collab-surface="room" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <textarea
        name="collab-text"
        aria-label={props.t("composer.messageAria")}
        placeholder={props.t("composer.placeholder")}
        value={draft}
        ref={textareaRef}
        rows={2}
        disabled={busy}
        onChange={(event) => { setDraft(event.target.value); setSelection({ start: event.target.selectionStart, end: event.target.selectionEnd }); setMentionIndex(0); setMentionOpen(true); setError(false); }}
        onSelect={(event) => { setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }); }}
        onKeyDown={onKeyDown}
      />
      {showMentions ? <ul role="listbox" aria-label={props.t("composer.mentionMembers")} className={css.mentionMenu} data-collab-mention-menu="true">
        {mentionOptions.map((member, index) => <li key={member.memberId}><button type="button" role="option" aria-selected={index === mentionIndex} onMouseDown={(event) => { event.preventDefault(); applyMemberMention(member, readSelection()); }}>{member.displayName}</button></li>)}
      </ul> : null}
      <div className={css.composerFooter}>
        <span className={css.composerHint}>{error ? props.t("composer.sendError") : props.t("composer.routeHint")}</span>
        <button type="submit" className={css.composerSubmit} disabled={busy || draft.trim() === ""}>{busy ? "…" : props.t("composer.send")}</button>
      </div>
    </form>
  );
}
