export type GalleryVersion = { id: string; revision: number; createdAt: string; reason: string; serveCount: number };
export type GalleryArtifact = { key: string; name: string; workspace: string; library_scope?: "private" | "team"; working: boolean; versions: GalleryVersion[]; kind?: "artifact" | "script"; serverOnly?: boolean; slug?: string; url?: string; access?: "private" | "public"; live?: { id: string; revision: number; revision_token: string }; liveId?: string; draftRevision?: string };
export type GalleryWorker = { key: string; kind: "worker"; name: string; workspace: string; provider: string; status: string; revision_token: string; slug?: string; url?: string; access?: "private" | "public" };
export type GalleryItem = GalleryArtifact | GalleryWorker;
/** Artifacts without a UI and legacy scripts are both HTTP servers in the gallery. */
export function isServerOnly(item: GalleryItem | null | undefined): boolean {
  return item?.kind === "script" || (item?.kind !== "worker" && !!item?.serverOnly);
}
export type GalleryData = { workspace: string; artifacts: GalleryArtifact[]; workerApps?: GalleryWorker[]; nativeAppProviders?: string[]; libraryScope?: "private" | "team"; nextOffset?: number | null; capabilities?: { scripts?: boolean; links?: boolean; moves?: boolean; trash?: boolean; nativeApps?: boolean; subscriptions?: boolean; subscriptionTransport?: "events"; editing?: boolean } };
