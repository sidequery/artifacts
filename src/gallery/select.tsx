import type { ComponentProps } from "react";

/** Native keyboard and touch behavior with a shared control shape. */
export function Select({ className = "", ...props }: ComponentProps<"select">) {
  return <span className={`select-control ${className}`}>
    <select {...props} />
    <span className="select-chevron" aria-hidden="true" />
  </span>;
}
