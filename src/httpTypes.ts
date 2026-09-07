export type CanvasHttpRequest = {
  path: string;
  method: string;
  headers: [string, string][];
  body?: string;
};

export type CanvasHttpResponse = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body?: string;
};
