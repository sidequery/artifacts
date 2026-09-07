import { base64url } from "jose";
export type Label = { prefix: string };
export function label(value: Label, count: number): string {
  return base64url.encode(`${value.prefix} ${count}`);
}
