- What an MCPL peer's content block carries in its other fields now
  reaches a script with RFC-005's treatment at any depth, as the block
  itself does: an RFC-005 reference there arrives as its stub's facts,
  bound to that server and not fetched for the script (its `savedTo` is
  null unless an earlier fetch saved that URI), one the classifier
  rejects as its notice, and inline data that also claims a URI of any
  type, an empty one included, or a disposition, as the withheld notice.
  Before, such fields reached a script whole, references' URIs included.
  `structuredContent` still reaches a script whole, from every tool, in
  any result that can be converted to JSON.
