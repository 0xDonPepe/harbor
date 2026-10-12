// End the CLI only once stdout has taken everything: process.exit() right after a write drops whatever a pipe has
// not accepted yet, so `harbor --json catalog | jq` stopped at 65536 bytes once the catalog grew past that.
export function exitAfterFlush(code: number): void {
  // stream writes complete in order, so this callback runs after every earlier write has been flushed
  process.stdout.write('', () => process.exit(code));
}
