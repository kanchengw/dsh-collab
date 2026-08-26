import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { JoinedRoomRef, ParticipantResumeState } from "./dsh-browser-client.js";
import type { DshCollabClientSnapshot, DshCollabGatewayRuntimeSnapshot, DshCollabOwnedRoom, DshCollabSettingsPort } from "./dsh-client.js";
import css from "./collab-rooms.module.css";

let panelOpen = false;
const panelListeners = new Set<() => void>();

export function setDshCollabRoomsOpen(open: boolean): void {
  if (panelOpen === open) return;
  panelOpen = open;
  for (const listener of panelListeners) listener();
}

function usePanelOpen(): boolean {
  const [open, setOpen] = useState(panelOpen);
  useEffect(() => {
    const listener = (): void => { setOpen(panelOpen); };
    panelListeners.add(listener);
    return () => { panelListeners.delete(listener); };
  }, []);
  return open;
}

function useGateway(port: DshCollabSettingsPort | undefined): DshCollabGatewayRuntimeSnapshot {
  const [gateway, setGateway] = useState<DshCollabGatewayRuntimeSnapshot>(() => port?.getGatewaySnapshot?.() ?? { status: "stopped" });
  useEffect(() => {
    const update = (): void => { setGateway(port?.getGatewaySnapshot?.() ?? { status: "stopped" }); };
    update();
    return port?.subscribeGateway?.(update);
  }, [port]);
  return gateway;
}

function useOwnedRooms(port: DshCollabSettingsPort | undefined): readonly DshCollabOwnedRoom[] {
  const [rooms, setRooms] = useState<readonly DshCollabOwnedRoom[]>(() => port?.getOwnedRooms?.() ?? []);
  useEffect(() => {
    const update = (): void => { setRooms(port?.getOwnedRooms?.() ?? []); };
    update();
    return port?.subscribeOwnedRooms?.(update);
  }, [port]);
  return rooms;
}

function useJoinedRooms(port: DshCollabSettingsPort | undefined): readonly ParticipantResumeState[] {
  const [rooms, setRooms] = useState<readonly ParticipantResumeState[]>(() => port?.listJoinedRooms?.() ?? []);
  useEffect(() => {
    const update = (): void => { setRooms(port?.listJoinedRooms?.() ?? []); };
    update();
    return port?.subscribeJoinedRooms?.(update);
  }, [port]);
  return rooms;
}

function useActiveRoom(port: DshCollabSettingsPort | undefined): Pick<DshCollabClientSnapshot, "roomId" | "role" | "connection"> | undefined {
  const [room, setRoom] = useState(() => port?.getRoomSnapshot?.());
  useEffect(() => {
    const update = (): void => { setRoom(port?.getRoomSnapshot?.()); };
    update();
    return port?.subscribeRoom?.(update);
  }, [port]);
  return room;
}

function Status({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "active" | "pending" }): ReactNode {
  return <span className={css.status} data-tone={tone}>{children}</span>;
}

function Action(props: { children: ReactNode; disabled?: boolean; onClick: () => void; primary?: boolean }): ReactNode {
  return <button type="button" className={props.primary ? css.primaryAction : css.action} disabled={props.disabled} onClick={props.onClick}>{props.children}</button>;
}

/** Additive action rendered in DSH's official sidebar footer slot. */
export function DshCollabRoomsLauncher({ wide }: { wide: boolean }): ReactNode {
  const open = usePanelOpen();
  return (
    <div className={wide ? css.launcherLayer : `${css.launcherLayer} ${css.rail}`}>
      <button type="button" className={css.launcher} aria-label="Collab Rooms" aria-expanded={open} onClick={() => { setDshCollabRoomsOpen(!open); }}>
        <span className={css.peopleIcon} aria-hidden="true"><span /><span /></span>
        {wide ? <span className={css.launcherLabel}>Collab Rooms</span> : null}
      </button>
    </div>
  );
}

export function DshCollabRoomsPanel({ port, openSession }: { port?: DshCollabSettingsPort; openSession?: (sessionId: string) => void }): ReactNode {
  const open = usePanelOpen();
  const gateway = useGateway(port);
  const ownedRooms = useOwnedRooms(port);
  const joinedRooms = useJoinedRooms(port);
  const activeRoom = useActiveRoom(port);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [displayName, setDisplayName] = useState("");
  const [invitation, setInvitation] = useState("");
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<{ tone: "error" | "success"; message: string }>();
  const participantConnected = activeRoom?.role === "participant" && activeRoom.connection !== "offline";

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === "Escape") setDshCollabRoomsOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    void Promise.all([port?.refreshGateway?.(), port?.refreshOwnedRooms?.()]).catch((cause) => {
      setNotice({ tone: "error", message: cause instanceof Error ? cause.message : "Unable to refresh Collab Rooms" });
    });
    return () => { window.removeEventListener("keydown", closeOnEscape); };
  }, [open, port]);

  if (!open) return null;

  const perform = async (key: string, action: () => void | Promise<void>, success?: string): Promise<void> => {
    setBusy(key);
    setNotice(undefined);
    try {
      await action();
      if (success) setNotice({ tone: "success", message: success });
    } catch (cause) {
      setNotice({ tone: "error", message: cause instanceof Error ? cause.message : "Collab action failed" });
    } finally {
      setBusy(undefined);
    }
  };
  const startSharing = async (room: DshCollabOwnedRoom): Promise<void> => {
    if (gateway.status !== "running") await port?.startGateway?.();
    if (!port?.shareHostRoom) throw new Error("Room sharing is unavailable");
    await port.shareHostRoom({ sessionId: room.hostSessionId, title: room.title });
  };
  const join = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!port?.join || participantConnected) return;
    await perform("join", async () => {
      await port.join?.({ invitation, displayName: displayName.trim() });
      setInvitation("");
    }, "Joined room saved. Connect and disconnect from the Joined rooms list.");
  };
  const startGateway = port?.startGateway;
  const stopGateway = port?.stopGateway;
  const stopSharing = port?.stopSharing;
  const connectJoinedRoom = port?.connectJoinedRoom;
  const forgetJoinedRoom = port?.forgetJoinedRoom;
  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Tab") return;
    const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? [])];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return (
    <div className={css.overlay} data-collab-rooms-overlay="true">
      <div className={css.mask} aria-hidden="true" onClick={() => { setDshCollabRoomsOpen(false); }} />
      <section ref={panelRef} className={css.panel} role="dialog" aria-modal="true" aria-labelledby="collab-rooms-title" onKeyDown={trapFocus}>
        <header className={css.panelHeader}>
          <div><h2 id="collab-rooms-title">Collab Rooms</h2><p>One Host Agent, shared with people you invite.</p></div>
          <button ref={closeRef} type="button" className={css.close} aria-label="Close Collab Rooms" onClick={() => { setDshCollabRoomsOpen(false); }}><span className={css.closeIcon} aria-hidden="true" /></button>
        </header>
        <div className={css.body}>
          <section className={css.gatewaySection} aria-labelledby="collab-gateway-title">
            <div className={css.sectionHeading}>
              <div><h3 id="collab-gateway-title">Gateway</h3><p>Starts only when you ask it to.</p></div>
              <Status tone={gateway.status === "running" ? "active" : gateway.status === "starting" ? "pending" : "neutral"}>{gateway.status === "running" ? `Running on ${String(gateway.port)}` : gateway.status === "starting" ? "Starting" : "Stopped"}</Status>
            </div>
            {gateway.status === "running"
              ? <Action disabled={!stopGateway || busy !== undefined} onClick={() => { void perform("gateway", async () => { await stopGateway?.(); }, "Gateway stopped. Owned rooms are no longer shared."); }}>Stop Gateway</Action>
              : <Action primary disabled={!startGateway || gateway.status === "starting" || busy !== undefined} onClick={() => { void perform("gateway", async () => { await startGateway?.(); }, "Gateway started."); }}>{gateway.status === "starting" ? "Starting..." : "Start Gateway"}</Action>}
          </section>

          <section className={css.roomSection} aria-labelledby="owned-rooms-title">
            <div className={css.sectionHeading}><div><h3 id="owned-rooms-title">Owned rooms</h3><p>Rooms bound to Agent sessions on this DSH.</p></div><span className={css.count}>{ownedRooms.length}</span></div>
            {ownedRooms.length === 0 ? <p className={css.empty}>No Owned rooms yet. Share a session from its conversation.</p> : <ul className={css.roomList}>{ownedRooms.map((room) => <li key={room.roomId} className={css.roomRow}>
              <div className={css.roomHead}><div><strong>{room.title}</strong><span>{room.hostSessionId}</span></div><Status tone={room.sharing ? "active" : "neutral"}>{room.sharing ? "Sharing" : "Not sharing"}</Status></div>
              <div className={css.actions}>
                <Action disabled={!openSession || busy !== undefined} onClick={() => { openSession?.(room.hostSessionId); setDshCollabRoomsOpen(false); }}>Open session</Action>
                {room.sharing
                  ? <Action disabled={!stopSharing || busy !== undefined} onClick={() => { void perform(`owned:${room.roomId}`, async () => { await stopSharing?.(room.roomId); }, "Sharing stopped. Room history remains saved."); }}>Stop sharing</Action>
                  : <Action primary disabled={!port?.shareHostRoom || busy !== undefined} onClick={() => { void perform(`owned:${room.roomId}`, () => startSharing(room), "Room is now shared."); }}>Start sharing</Action>}
              </div>
            </li>)}</ul>}
          </section>

          <section className={css.roomSection} aria-labelledby="joined-rooms-title">
            <div className={css.sectionHeading}><div><h3 id="joined-rooms-title">Joined rooms</h3><p>Saved remote memberships. They never connect automatically.</p></div><span className={css.count}>{joinedRooms.length}</span></div>
            {joinedRooms.length === 0 ? <p className={css.empty}>No Joined rooms saved.</p> : <ul className={css.roomList}>{joinedRooms.map((room) => {
              const active = participantConnected && activeRoom.roomId === room.roomId;
              const ref: JoinedRoomRef = { gatewayEndpoint: room.gatewayEndpoint, roomId: room.roomId };
              return <li key={`${room.gatewayEndpoint}:${room.roomId}`} className={css.roomRow}>
                <div className={css.roomHead}><div><strong>{room.roomTitle ?? room.roomId}</strong><span>{room.hostDisplayName ? `Hosted by ${room.hostDisplayName}` : room.gatewayEndpoint}</span></div><Status tone={activeRoom?.connection === "connecting" && active ? "pending" : active ? "active" : "neutral"}>{active ? activeRoom?.connection === "connecting" ? "Connecting" : "Connected" : "Disconnected"}</Status></div>
                <div className={css.actions}>
                  {active
                    ? <Action disabled={!port?.disconnectJoinedRoom || busy !== undefined} onClick={() => { port?.disconnectJoinedRoom?.(); }}>Disconnect</Action>
                    : <Action primary disabled={!connectJoinedRoom || participantConnected || busy !== undefined} onClick={() => { void perform(`joined:${room.roomId}`, async () => { await connectJoinedRoom?.(ref); }); }}>Connect</Action>}
                  <Action disabled={!forgetJoinedRoom || busy !== undefined} onClick={() => { void perform(`forget:${room.roomId}`, async () => { await forgetJoinedRoom?.(ref); }, "Joined room forgotten."); }}>Forget</Action>
                </div>
              </li>;
            })}</ul>}
          </section>

          <form className={css.joinSection} onSubmit={(event) => { void join(event); }}>
            <div className={css.sectionHeading}><div><h3>Join a room</h3><p>Paste an invitation from its Owner. Your local Agent is not used.</p></div></div>
            <label className={css.field}>Your display name<input name="displayName" value={displayName} autoComplete="name" onChange={(event) => { setDisplayName(event.target.value); }} disabled={!port?.join || participantConnected || busy !== undefined} /></label>
            <label className={css.field}>Invitation<textarea name="participantInvitation" value={invitation} rows={4} spellCheck={false} onChange={(event) => { setInvitation(event.target.value); }} disabled={!port?.join || participantConnected || busy !== undefined} /></label>
            {participantConnected ? <p className={css.joinHint}>Disconnect the current Joined room before joining another.</p> : null}
            <button type="submit" className={css.joinButton} disabled={!port?.join || participantConnected || busy !== undefined || displayName.trim() === "" || invitation.trim() === ""}>{busy === "join" ? "Joining..." : "Join room"}</button>
          </form>
          {notice ? <p className={notice.tone === "error" ? css.error : css.success} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p> : null}
        </div>
      </section>
    </div>
  );
}
