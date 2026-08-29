import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DshCollabRoomsPanel, setDshCollabRoomsOpen } from "../../src/collab-rooms.js";
import { DshCollabSettingsPanel } from "../../src/collab-settings-card.js";
import { applyDshCollabClient, DshCollabSessionAction, type DshCollabClientContext, type DshCollabSettingsPort } from "../../src/dsh-client.js";
import { COLLAB_LOCALE_NAMESPACE, en, zh, type CollabTranslate } from "../../src/locales.js";

const t: CollabTranslate = (key, params) => {
  const template = zh[key];
  return params
    ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
    : template;
};

const port: DshCollabSettingsPort = {
  getSnapshot: () => ({ gatewayHost: "0.0.0.0", gatewayPort: 4310, exposeMode: "network", advertisedEndpoint: "ws://192.168.1.20:4310/collab" }),
  getGatewaySnapshot: () => ({ status: "stopped" }),
  getOwnedRooms: () => [{ roomId: "room-owned", hostSessionId: "session-owned", title: "Release planning", sharing: false }],
  listJoinedRooms: () => [{ gatewayEndpoint: "wss://alice.example/collab", roomId: "room-joined", memberId: "member-bob", credential: "secret", roomTitle: "Design review", hostDisplayName: "Alice" }],
  getRoomSnapshot: () => ({ roomId: "", roomTitle: "", hostDisplayName: "", role: "participant", connection: "offline" }),
  save: vi.fn(),
  startGateway: vi.fn(),
  shareHostRoom: vi.fn(),
};

describe("dsh-collab locale dictionaries", () => {
  it("ships balanced English and Simplified Chinese dictionaries", () => {
    expect(COLLAB_LOCALE_NAMESPACE).toBe("dsh-collab");
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    expect(zh["room.hostStoppedSharing"]).toContain("主机已停止分享");
    expect(zh["room.hostUnreachable"]).toContain("主机是否在线");
    expect(zh["room.resourceLimited"]).toContain("稍后重试");
  });

  it("registers its dictionaries and declares the locale namespace on every DSH slot", () => {
    const registrations: Array<{ options: Record<string, unknown>; component: (props: Record<string, unknown>) => ReactNode }> = [];
    const registerLocale = vi.fn(() => () => {});
    applyDshCollabClient({
      locale: { register: registerLocale, bind: () => t },
      effect: (callback) => callback(),
      slots: {
        inject: (_name, register) => register(),
        register: (options, component) => { registrations.push({ options, component }); return () => {}; },
      },
    } as DshCollabClientContext);

    expect(registerLocale).toHaveBeenCalledWith(COLLAB_LOCALE_NAMESPACE, { zh, en });
    expect(registrations).toHaveLength(5);
    expect(registrations.every(({ options }) => options.locale === COLLAB_LOCALE_NAMESPACE)).toBe(true);
    const launcher = registrations.find(({ options }) => options.name === "sidebar.footer.action");
    expect(renderToStaticMarkup(launcher!.component({ wide: true, t }))).toContain("协作房间");
  });

  it("renders the persistent settings surface in Simplified Chinese", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsPanel, { port, t }));

    expect(html).toContain("协作网关");
    expect(html).toContain("连接方式");
    expect(html).toContain("私有网络");
    expect(html).toContain("高级选项");
    expect(html).toContain("安全");
    expect(html).toContain("聊天");
    expect(html).toContain("局域网设置");
  });

  it("renders Collab Rooms and session sharing controls in Simplified Chinese", () => {
    setDshCollabRoomsOpen(true);
    const rooms = renderToStaticMarkup(createElement(DshCollabRoomsPanel, { port, t }));
    setDshCollabRoomsOpen(false);
    const action = renderToStaticMarkup(createElement(DshCollabSessionAction, {
      sessionId: "session-current",
      defaultRoomName: "Release planning",
      fallback: { roomId: "", roomTitle: "", hostDisplayName: "", role: "participant", connection: "offline", onlineCount: 0, canSteer: false },
      t,
    }));

    expect(rooms).toContain("协作房间");
    expect(rooms).toContain("我创建的房间");
    expect(rooms).toContain("我加入的房间");
    expect(rooms).not.toContain("启动网关");
    expect(action).toContain("共享为协作房间");
  });
});
