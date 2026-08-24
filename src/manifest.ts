export interface DshCollabManifest {
  name: string;
  exports: Record<string, unknown>;
  dsh?: {
    client?: { platform: "web"; inject?: string[] };
    bundle?: { patch: string };
  };
}

export function validateDshCollabManifest(manifest: DshCollabManifest): void {
  if (manifest.name !== "dsh-collab") throw new Error("manifest name must be dsh-collab");
  if (!manifest.exports["./client"]) throw new Error("manifest must export ./client");
  if (manifest.dsh?.client?.platform !== "web") throw new Error("client platform must be web");
  if (manifest.dsh?.bundle?.patch !== "./cordis.patch.yml") {
    throw new Error("manifest must declare the dsh bundle patch");
  }
}
