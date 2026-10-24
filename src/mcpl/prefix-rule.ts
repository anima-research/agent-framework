/**
 * When two MCPL servers' tool names can be the same name (#265).
 *
 * A server's tool reaches the model as `<toolPrefix>--<tool>`. Two prefixes
 * give one name only when they meet: they're the same, one is the other's
 * followed by `-`, or one begins with the other's followed by `--`. Server
 * `foo` listing `bar--echo` and server `foo--bar` listing `echo` both give
 * `foo--bar--echo`, and `foo` listing `-echo` and `foo-` listing `echo` both
 * give `foo---echo`. Prefixes that don't meet never give one name, whatever
 * their servers list, so `foo` beside `foo-bar` or `foobar` is fine.
 */
export function prefixesMeet(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer === shorter || longer === `${shorter}-` || longer.startsWith(`${shorter}--`);
}

/**
 * The refusal for a server whose prefix meets another's: both servers, both
 * prefixes, and the rule.
 */
export function prefixesMeetError(
  serverId: string,
  prefix: string,
  otherId: string,
  otherPrefix: string,
): Error {
  return new Error(
    `MCPL server "${serverId}" toolPrefix "${prefix}" meets server "${otherId}"'s toolPrefix "${otherPrefix}": ` +
      `two prefixes can give one tool name when one is the other's followed by "-", or begins with the other's ` +
      `followed by "--". Give one of the two servers a toolPrefix that doesn't meet the other's.`,
  );
}
