export type Version = {
  id: string; artifact_id: string; revision: number; source: string;
  server_source?: string | null;
  source_hash: string; runtime: string;
  created_at: string; reason: string; restored_from: string | null;
  workspace: string; name: string; source_path: string;
};
export type ServeEvent = {
  id: string; version_id: string; served_at: string; pane_id: string | null;
  session_id: string | null; mode: string; initial_state: string; runtime: string;
};
export type HistoryEntry = {
  artifact_id: string; name: string; source_path: string; workspace: string;
  version_id: string; revision: number; created_at: string; source_hash: string;
  runtime: string; reason: string; restored_from: string | null; serve_count: number;
};
