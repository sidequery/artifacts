export type GalleryVersion = { id: string; revision: number; createdAt: string; reason: string; serveCount: number };
export type GalleryArtifact = { key: string; name: string; workspace: string; working: boolean; versions: GalleryVersion[]; kind?: "artifact" | "script"; slug?: string; url?: string; access?: "private" | "public"; live?: { id: string; revision: number; revision_token: string }; liveId?: string; draftRevision?: string };
export type GalleryWorker = { key: string; kind: "worker"; name: string; workspace: string; provider: string; status: string; revision_token: string };
export type GalleryItem = GalleryArtifact | GalleryWorker;
export type GalleryData = { workspace: string; artifacts: GalleryArtifact[]; workerApps?: GalleryWorker[]; nativeAppProviders?: string[]; libraryScope?: "private" | "team"; nextOffset?: number | null; capabilities?: { scripts?: boolean; links?: boolean; moves?: boolean; nativeApps?: boolean; subscriptions?: boolean } };
