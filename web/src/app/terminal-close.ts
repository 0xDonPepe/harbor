// Why a terminal closed. The daemon sends {type:'exit', reason} (or {type:'error'}) and then closes the
// socket; the close and error events that follow must not wipe that reason, so the first one given wins.
// Decision 169: "Closed · your session ended …" is how the operator learns a logout ended the shell.
export function closeReasons(): { closed: (reason?: string) => string | undefined } {
  let reason: string | undefined;
  return {
    closed(next) {
      reason ??= next;
      return reason;
    },
  };
}
