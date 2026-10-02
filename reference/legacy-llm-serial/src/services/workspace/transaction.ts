/**
 * Run a workspace replacement as one logical operation.
 *
 * The caller owns the snapshot because the live state spans Vue, transport,
 * dashboard and project-model services. This helper only guarantees that a
 * failed apply gets one rollback attempt before the error is returned.
 */
export type WorkspaceTransactionResult =
  | { ok: true }
  | { ok: false; error: unknown; rollbackError?: unknown };

export async function runWorkspaceTransaction<TSnapshot>(
  snapshot: TSnapshot,
  apply: () => void | Promise<void>,
  rollback: (snapshot: TSnapshot) => void | Promise<void>,
): Promise<WorkspaceTransactionResult> {
  try {
    await apply();
    return { ok: true };
  } catch (error) {
    try {
      await rollback(snapshot);
      return { ok: false, error };
    } catch (rollbackError) {
      return { ok: false, error, rollbackError };
    }
  }
}
