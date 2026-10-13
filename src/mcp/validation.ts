export type ArgumentValidator = {
  (args: unknown): boolean;
  errors?: readonly { instancePath?: string; message?: string }[] | null;
};

export function validateToolArguments(validators: Record<string, ArgumentValidator>, name: string, args: unknown): void {
  if (!Object.hasOwn(validators, name)) throw new Error("Unknown tool");
  const validate = validators[name]!;
  if (!validate(args)) {
    const details = validate.errors?.slice(0, 5).map(error => `${error.instancePath || "/"} ${error.message}`).join("; ");
    throw new Error(`Invalid arguments for ${name}${details ? ": " + details : ""}`);
  }
}
