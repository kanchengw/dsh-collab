import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { privateAddressFromGatewayEndpoint, privateGatewayEndpoint } from "./endpoint-policy.js";
import { defaultCollabSettings } from "./settings-shared.js";
import type { DshCollabSettingsPort, DshCollabSettingsSnapshot } from "./dsh-client.js";
import css from "./collab-settings-card.module.css";

type Notice = { tone: "error" | "success"; message: string };
type ConnectionMethod = "unconfigured" | "private-network" | "custom-wss";

function connectionMethodFor(settings: DshCollabSettingsSnapshot): ConnectionMethod {
  if (settings.exposeMode === "network") return "private-network";
  return settings.advertisedEndpoint.startsWith("wss://") ? "custom-wss" : "unconfigured";
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function Field(props: { id: string; label: string; hint: string; children: ReactNode }): ReactNode {
  return (
    <div className={css.field}>
      <label className={css.label} htmlFor={props.id}>{props.label}</label>
      {props.children}
      <p className={css.hint}>{props.hint}</p>
    </div>
  );
}

function useRoom(port: DshCollabSettingsPort | undefined): ReturnType<NonNullable<DshCollabSettingsPort["getRoomSnapshot"]>> | undefined {
  const [room, setRoom] = useState(() => port?.getRoomSnapshot?.());
  useEffect(() => {
    setRoom(port?.getRoomSnapshot?.());
    return port?.subscribeRoom?.(() => { setRoom(port.getRoomSnapshot?.()); });
  }, [port]);
  return room;
}

function RoleStatus({ port }: { port?: DshCollabSettingsPort }): ReactNode {
  const room = useRoom(port);
  const remote = room?.role === "participant" && room.connection !== "offline";
  const label = remote ? "Participant" : room?.role === "host" && room.connection !== "offline" ? "Host" : "Ready";
  return (
    <div className={css.roleStatus} data-room-role={room?.role ?? "none"}>
      <span className={css.roleBadge}>{label}</span>
      <span className={css.roleCopy}>
        {remote
          ? `${room.roomTitle} · Hosted by ${room.hostDisplayName}`
          : room?.role === "host" && room.connection !== "offline"
            ? `${room.roomTitle} · ${room.connection}`
            : "Host your own room or join an invitation from another Host."}
      </span>
    </div>
  );
}

/** The task-oriented contents of the Collab settings card. */
export function DshCollabSettingsPanel({ port }: { port?: DshCollabSettingsPort }): ReactNode {
  const initial = useMemo<DshCollabSettingsSnapshot>(() => port?.getSnapshot() ?? { ...defaultCollabSettings }, [port]);
  const [saved, setSaved] = useState(initial);
  const [connectionMethod, setConnectionMethod] = useState<ConnectionMethod>(() => connectionMethodFor(initial));
  const [privateAddress, setPrivateAddress] = useState(() => initial.exposeMode === "network" ? privateAddressFromGatewayEndpoint(initial.advertisedEndpoint) : "");
  const [advertisedEndpoint, setAdvertisedEndpoint] = useState(initial.advertisedEndpoint);
  const [tokenTtlMs, setTokenTtlMs] = useState(String(initial.tokenTtlMs ?? defaultCollabSettings.tokenTtlMs));
  const [approvalPolicy, setApprovalPolicy] = useState(initial.approvalPolicy ?? defaultCollabSettings.approvalPolicy);
  const [maxMembers, setMaxMembers] = useState(String(initial.maxMembers ?? defaultCollabSettings.maxMembers));
  const [maxMessageBytes, setMaxMessageBytes] = useState(String(initial.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes));
  const [maxQueue, setMaxQueue] = useState(String(initial.maxQueue ?? defaultCollabSettings.maxQueue));
  const [participantInvitation, setParticipantInvitation] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState<"save" | "join">();
  const [notice, setNotice] = useState<Notice>();
  const writable = port !== undefined && saved.writable !== false;
  const configurationDisabled = !writable || busy !== undefined;

  const resetDraft = (snapshot = saved): void => {
    setConnectionMethod(connectionMethodFor(snapshot));
    setPrivateAddress(snapshot.exposeMode === "network" ? privateAddressFromGatewayEndpoint(snapshot.advertisedEndpoint) : "");
    setAdvertisedEndpoint(snapshot.advertisedEndpoint);
    setTokenTtlMs(String(snapshot.tokenTtlMs ?? defaultCollabSettings.tokenTtlMs));
    setApprovalPolicy(snapshot.approvalPolicy ?? defaultCollabSettings.approvalPolicy);
    setMaxMembers(String(snapshot.maxMembers ?? defaultCollabSettings.maxMembers));
    setMaxMessageBytes(String(snapshot.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes));
    setMaxQueue(String(snapshot.maxQueue ?? defaultCollabSettings.maxQueue));
  };

  useEffect(() => port?.subscribe?.(() => {
    const snapshot = port.getSnapshot();
    setSaved(snapshot);
    resetDraft(snapshot);
  }), [port]);

  const exposeMode: "loopback" | "network" = connectionMethod === "private-network" ? "network" : "loopback";
  let privateEndpoint = "";
  if (connectionMethod === "private-network" && privateAddress.trim() !== "") {
    try { privateEndpoint = privateGatewayEndpoint(privateAddress, saved.gatewayPort); } catch { /* validation is shown on save */ }
  }
  const dirty = exposeMode !== saved.exposeMode
    || (connectionMethod === "private-network" ? privateEndpoint : connectionMethod === "custom-wss" ? advertisedEndpoint : "") !== saved.advertisedEndpoint
    || tokenTtlMs !== String(saved.tokenTtlMs ?? defaultCollabSettings.tokenTtlMs)
    || approvalPolicy !== (saved.approvalPolicy ?? defaultCollabSettings.approvalPolicy)
    || maxMembers !== String(saved.maxMembers ?? defaultCollabSettings.maxMembers)
    || maxMessageBytes !== String(saved.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes)
    || maxQueue !== String(saved.maxQueue ?? defaultCollabSettings.maxQueue);
  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!port || !writable) return;
    setBusy("save");
    setNotice(undefined);
    try {
      const next = {
        gatewayHost: exposeMode === "loopback" ? "127.0.0.1" as const : "0.0.0.0" as const,
        gatewayPort: saved.gatewayPort,
        exposeMode,
        advertisedEndpoint: connectionMethod === "private-network"
          ? privateGatewayEndpoint(privateAddress, saved.gatewayPort)
          : connectionMethod === "custom-wss" ? advertisedEndpoint.trim() : "",
        tokenTtlMs: Number(tokenTtlMs),
        approvalPolicy,
        maxMembers: Number(maxMembers),
        maxMessageBytes: Number(maxMessageBytes),
        maxQueue: Number(maxQueue),
      };
      await port.save(next);
      const committed = port.getSnapshot();
      setSaved(committed);
      resetDraft(committed);
      setNotice({ tone: "success", message: "Settings saved. Restart DSH to apply them." });
    } catch (cause) {
      setNotice({ tone: "error", message: errorMessage(cause, "Unable to save collaboration settings") });
    } finally {
      setBusy(undefined);
    }
  };

  const join = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!port?.join) return;
    setBusy("join");
    setNotice(undefined);
    try {
      await port.join({ invitation: participantInvitation, displayName: displayName.trim() });
      setParticipantInvitation("");
      setNotice({ tone: "success", message: "Joined as Participant. This DSH will reconnect after restart." });
    } catch (cause) {
      setNotice({ tone: "error", message: errorMessage(cause, "Unable to join the room") });
    } finally {
      setBusy(undefined);
    }
  };

  const inputClass = css.input;
  return (
    <div className={css.body} data-settings-namespace="dsh-collab">
      <RoleStatus port={port} />
      {!writable && port ? <p className={css.readOnly} role="status">Collaboration settings are read-only in this DSH profile.</p> : null}

      <form className={css.section} onSubmit={(event) => { void save(event); }}>
        <div className={css.sectionHead}>
          <div><h3>Host a room</h3><p>Run the only Agent and a dedicated Collab Gateway on this DSH.</p></div>
          {dirty ? <span className={css.pending}>Unsaved</span> : null}
        </div>
        <Field id="collab-connection-method" label="Connection method" hint="Use a private network directly, or provide a secure WSS address that forwards to this Host.">
          <select id="collab-connection-method" name="connectionMethod" className={inputClass} value={connectionMethod} onChange={(event) => {
            const next = event.target.value as ConnectionMethod;
            setConnectionMethod(next);
            if (next === "custom-wss" && !advertisedEndpoint.trim().startsWith("wss://")) setAdvertisedEndpoint("");
          }} disabled={configurationDisabled}>
            <option value="unconfigured" disabled>Not configured</option>
            <option value="private-network">Private network</option>
            <option value="custom-wss">Custom WSS endpoint</option>
          </select>
        </Field>
        {connectionMethod === "private-network" ? <>
          <Field id="collab-private-address" label="Private address" hint="Use the private IP that other devices can reach. Collab selects and remembers an available Gateway port automatically.">
            <input id="collab-private-address" name="privateAddress" className={inputClass} type="text" value={privateAddress} onChange={(event) => { setPrivateAddress(event.target.value); }} placeholder="192.168.1.20" disabled={configurationDisabled} />
          </Field>
          <Field id="collab-derived-endpoint" label="Invitation endpoint" hint="The /collab path is fixed for private-network rooms.">
            <input id="collab-derived-endpoint" name="derivedEndpoint" className={inputClass} type="text" value={privateEndpoint} readOnly aria-readonly="true" />
          </Field>
        </> : null}
        {connectionMethod === "custom-wss" ? <Field id="collab-address" label="Custom WSS endpoint" hint="Enter the secure endpoint that forwards to this Host Gateway.">
          <input id="collab-address" name="advertisedEndpoint" className={inputClass} type="url" value={advertisedEndpoint} onChange={(event) => { setAdvertisedEndpoint(event.target.value); }} placeholder="wss://collab.example.com/collab" disabled={configurationDisabled} />
        </Field> : null}
        {exposeMode === "network" ? <p className={css.warning} role="status"><strong>Private network exposure</strong><span>Only share invitations with people you trust. Room tokens still gate access.</span></p> : null}
        <details className={css.details}>
          <summary>Room safety and limits</summary>
          <Field id="collab-token-ttl" label="Room token lifetime (ms)" hint="Short-lived authorization issued after joining."><input id="collab-token-ttl" name="tokenTtlMs" className={inputClass} type="text" inputMode="numeric" value={tokenTtlMs} onChange={(event) => { setTokenTtlMs(event.target.value); }} disabled={configurationDisabled} /></Field>
          <Field id="collab-approval" label="Tool approvals" hint="Participants can never answer Host Agent approvals."><select id="collab-approval" name="approvalPolicy" className={inputClass} value={approvalPolicy} onChange={(event) => { setApprovalPolicy(event.target.value as "host-only" | "disabled"); }} disabled={configurationDisabled}><option value="host-only">Host only</option><option value="disabled">Disabled</option></select></Field>
          <div className={css.limitGrid}>
            <Field id="collab-members" label="Maximum members" hint="Active room members."><input id="collab-members" name="maxMembers" className={inputClass} type="text" inputMode="numeric" value={maxMembers} onChange={(event) => { setMaxMembers(event.target.value); }} disabled={configurationDisabled} /></Field>
            <Field id="collab-message-bytes" label="Maximum message bytes" hint="Per submitted message."><input id="collab-message-bytes" name="maxMessageBytes" className={inputClass} type="text" inputMode="numeric" value={maxMessageBytes} onChange={(event) => { setMaxMessageBytes(event.target.value); }} disabled={configurationDisabled} /></Field>
            <Field id="collab-queue" label="Maximum Agent queue" hint="Waiting DSH requests."><input id="collab-queue" name="maxQueue" className={inputClass} type="text" inputMode="numeric" value={maxQueue} onChange={(event) => { setMaxQueue(event.target.value); }} disabled={configurationDisabled} /></Field>
          </div>
        </details>
        <div className={css.formFooter}>
          <span>Restart DSH to apply Gateway and room safety changes.</span>
          <button type="button" className={css.secondaryButton} onClick={() => { resetDraft(); }} disabled={!dirty || busy !== undefined}>Discard</button>
          <button type="submit" className={css.primaryButton} disabled={!writable || !dirty || busy !== undefined}>{busy === "save" ? "Saving…" : "Save"}</button>
        </div>
      </form>

      <form className={css.section} onSubmit={(event) => { void join(event); }}>
        <div className={css.sectionHead}><div><h3>Join someone else</h3><p>This DSH becomes the Participant UI for that remote room; its local Agent is not used.</p></div></div>
        <Field id="collab-display-name" label="Your display name" hint="Shown to everyone in the room."><input id="collab-display-name" name="displayName" className={inputClass} value={displayName} onChange={(event) => { setDisplayName(event.target.value); }} autoComplete="name" disabled={!port?.join || busy !== undefined} /></Field>
        <Field id="collab-participant-invitation" label="Invitation" hint="Paste the complete JSON invitation exactly as the Host shared it."><textarea id="collab-participant-invitation" name="participantInvitation" className={css.textarea} value={participantInvitation} onChange={(event) => { setParticipantInvitation(event.target.value); }} rows={5} spellCheck={false} disabled={!port?.join || busy !== undefined} /></Field>
        <div className={css.formFooter}><span>A successful join is saved locally for automatic recovery.</span><button type="submit" className={css.primaryButton} disabled={!port?.join || busy !== undefined || displayName.trim() === "" || participantInvitation.trim() === ""}>{busy === "join" ? "Joining…" : "Join room"}</button></div>
      </form>

      {notice ? <p className={notice.tone === "error" ? css.errorNotice : css.successNotice} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p> : null}
    </div>
  );
}

/** Collapsible list item matching DSH's official plugin-settings card chrome. */
export function DshCollabSettingsCard({ port }: { port?: DshCollabSettingsPort }): ReactNode {
  const [open, setOpen] = useState(false);
  const room = useRoom(port);
  const active = room?.connection !== undefined && room.connection !== "offline";
  return (
    <li className={open ? `${css.card} ${css.cardOpen}` : css.card} data-collab-settings-card="true" data-settings-namespace="dsh-collab">
      <button type="button" className={css.cardHeader} aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"}: dsh-collab`} onClick={() => { setOpen(!open); }}>
        <span className={css.cardTitle}><strong>dsh-collab</strong><span>Share one Host Agent with other people</span></span>
        {active ? <span className={css.activeBadge}>{room.role === "host" ? "Hosting" : "Joined"}</span> : null}
        <span className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron} aria-hidden="true">⌄</span>
      </button>
      {open ? <DshCollabSettingsPanel port={port} /> : null}
    </li>
  );
}
