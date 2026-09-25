import { useState, type KeyboardEvent, type ReactNode } from "react";
import { composerKeyAction, composerTargetForGesture } from "./ui.js";
import type { DshCollabClientPort, DshCollabClientSnapshot } from "./dsh-client.js";
import type { CollabTranslate } from "./locales.js";
import css from "./collab-room.module.css";

export function DshCollabComposer(props: {
  port: DshCollabClientPort;
  snapshot: DshCollabClientSnapshot;
  t: CollabTranslate;
}): ReactNode {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const agentBusy = (props.snapshot.agentQueue ?? []).some((item) => item.status === "running");
  const target = composerTargetForGesture(draft, agentBusy, false);

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (text === "" || busy) return;
    setBusy(true);
    setError(false);
    try {
      await props.port.send({ text, target });
      setDraft("");
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
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
        rows={2}
        disabled={busy}
        onChange={(event) => { setDraft(event.target.value); setError(false); }}
        onKeyDown={onKeyDown}
      />
      <div className={css.composerFooter}>
        <span className={css.composerHint}>{error ? props.t("composer.sendError") : props.t(target === "dsh" ? "composer.routeAgent" : "composer.routeHint")}</span>
        <button type="submit" className={css.composerSubmit} disabled={busy || draft.trim() === ""}>{busy ? "…" : props.t("composer.send")}</button>
      </div>
    </form>
  );
}
