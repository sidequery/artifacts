import type { DurableObjectStub, DurableObjectNamespace } from "@cloudflare/workers-types";
import type { ArtifactLinks, ArtifactTarget } from "./links";
import type { ScriptLibrary } from "./scripts";
import type { ScriptBackend } from "./script-backend";

export type HostedArtifacts = {
  links: DurableObjectStub<ArtifactLinks>;
  scripts: DurableObjectStub<ScriptLibrary>;
  scriptBackends: DurableObjectNamespace<ScriptBackend>;
  origin: string;
  publicOrigin?: string;
};

/** Shared artifact identity and URL metadata for artifact and script operations. */
export class ArtifactService {
  constructor(readonly workspace: string, readonly libraryKey: string, readonly hosted?: HostedArtifacts) {}

  requireHosted(): HostedArtifacts {
    if (!this.hosted) throw new Error("Standalone artifacts are unavailable in this runtime");
    return this.hosted;
  }

  target(kind: "artifact" | "script", name: string): ArtifactTarget {
    return { libraryKey: this.libraryKey, workspace: this.workspace, kind, name: name.trim().replace(kind === "artifact" ? /\.artifact\.tsx$/ : /\.script\.ts$/, "") };
  }

  async linkDetails(target: ArtifactTarget) {
    const link = await this.hosted?.links.find(target);
    if (link) return { slug: link.slug, access: link.access, url: `${this.hosted!.publicOrigin ?? this.hosted!.origin}/${link.slug}` };
    const pending = await this.hosted?.links.draft(target);
    return pending?.slug ? { slug: pending.slug, access: pending.access ?? "private" } : {};
  }
}
