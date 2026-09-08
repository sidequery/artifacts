export type ArtifactHttpRequest = {
  path: string;
  method: string;
  headers: [string, string][];
  body?: string;
};

export type ArtifactHttpResponse = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body?: string;
};
