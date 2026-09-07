export type GalleryVersion = { id: string; revision: number; createdAt: string; reason: string; serveCount: number };
export type GalleryArtifact = { key: string; name: string; workspace: string; working: boolean; versions: GalleryVersion[]; kind?: "canvas" | "script"; slug?: string; url?: string; access?: "private" | "public" };
export type GalleryData = { workspace: string; artifacts: GalleryArtifact[]; libraryScope?: "private" | "team"; nextOffset?: number | null; capabilities?: { scripts?: boolean; links?: boolean } };
