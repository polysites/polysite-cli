import { refused } from "./errors.js";

/**
 * A typed confirmation for a destructive step. The operator types back `expected` (a plugin slug, a backup name), or a
 * script passes it up front with --confirm. `--yes` does NOT satisfy it: a habit of adding -y must never be enough to
 * destroy data. Throws a "refused" error (exit code 4) when it is not given.
 */
export async function confirmTyped(ctx, message, expected) {
  if (ctx.confirmText !== undefined) {
    if (ctx.confirmText === expected) return;
    throw refused(`--confirm "${ctx.confirmText}" does not match "${expected}". Nothing was changed.`);
  }
  const prompter = ctx.prompter();
  if (!prompter.interactive) {
    throw refused(`This needs a typed confirmation and there is no terminal to ask on. Nothing was changed.`, `Run it in a terminal, or pass --confirm ${expected}`);
  }
  if (!(await prompter.typeToConfirm(message, expected))) throw refused("Not confirmed. Nothing was changed.");
}

/** A plain yes/no. `--yes` answers it; without a terminal and without --yes it is refused. */
export async function confirmYes(ctx, question) {
  if (ctx.yes) return;
  const prompter = ctx.prompter();
  if (!prompter.interactive) throw refused("This needs a confirmation and there is no terminal to ask on. Nothing was changed.", "Pass --yes to confirm.");
  if (!(await prompter.yesNo(question, false))) throw refused("Cancelled. Nothing was changed.");
}
