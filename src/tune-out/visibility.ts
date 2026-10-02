/** The same permanent exclusion applies to compiles and live continuations. */
export function isResidentVisibleMessage(message: { metadata?: unknown }): boolean {
  return !(message.metadata as { tuneOut?: unknown } | undefined)?.tuneOut;
}
