import { describe, expect, it } from "vitest";
import { gatewayHttpUrl, normalizeGatewayEndpoint, privateAddressFromGatewayEndpoint, privateGatewayEndpoint } from "../../src/endpoint-policy.js";

describe("Collab Gateway endpoint policy", () => {
  it("allows insecure WebSocket only for explicit local and private addresses", () => {
    for (const endpoint of [
      "ws://127.0.0.1:4310/collab",
      "ws://10.0.0.8:4310/collab/",
      "ws://100.64.0.8:4310/collab",
      "ws://100.127.255.254:4310/collab",
      "ws://172.16.4.2:4310/collab",
      "ws://172.31.255.254:4310/collab",
      "ws://192.168.1.20:4310/collab",
      "ws://[::1]:4310/collab",
      "ws://[fd12:3456::8]:4310/collab",
      "ws://[fe80::8]:4310/collab",
    ]) expect(normalizeGatewayEndpoint(endpoint)).toMatch(/^ws:/);

    for (const endpoint of [
      "ws://collab.example/collab",
      "ws://8.8.8.8:4310/collab",
      "ws://100.128.0.1:4310/collab",
      "ws://fd-company.example/collab",
      "ws://172.32.0.1:4310/collab",
      "ws://0.0.0.0:4310/collab",
      "ws://[::]:4310/collab",
    ]) expect(() => normalizeGatewayEndpoint(endpoint)).toThrow("wss");
  });

  it("accepts secure external endpoints and rejects URL ambiguity", () => {
    expect(normalizeGatewayEndpoint(" wss://collab.example/collab/ ")).toBe("wss://collab.example/collab");
    expect(gatewayHttpUrl("wss://collab.example/collab")).toBe("https://collab.example/collab");
    expect(gatewayHttpUrl("ws://192.168.1.20:4310/collab")).toBe("http://192.168.1.20:4310/collab");

    for (const endpoint of [
      "https://collab.example/collab",
      "wss://user:pass@collab.example/collab",
      "wss://collab.example/collab?token=secret",
      "wss://collab.example/collab#fragment",
      "wss://collab.example/not-collab",
    ]) expect(() => normalizeGatewayEndpoint(endpoint)).toThrow("gatewayEndpoint");
  });

  it("derives a fixed private-network endpoint from address and selected port", () => {
    expect(privateGatewayEndpoint("192.168.1.20", 4312)).toBe("ws://192.168.1.20:4312/collab");
    expect(privateGatewayEndpoint("fd12:3456::8", 4313)).toBe("ws://[fd12:3456::8]:4313/collab");
    expect(privateAddressFromGatewayEndpoint("ws://192.168.1.20:4312/collab")).toBe("192.168.1.20");
    expect(() => privateGatewayEndpoint("8.8.8.8", 4312)).toThrow("wss");
  });
});
