import { EXIT } from "./constants.js";

/** An expected failure: the message is shown as is, with an optional hint on what to do about it. */
export class CliError extends Error {
  constructor(message, { code = EXIT.FAILED, hint = null, data = null } = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.hint = hint;
    this.data = data;
  }
}

export const usageError = (message, hint) => new CliError(message, { code: EXIT.USAGE, hint });
export const refused = (message, hint) => new CliError(message, { code: EXIT.REFUSED, hint });
