- When the tool-result guard withholds a batch, an error result no longer reads
  "The tool has already executed.": a refused call's (`ToolResult.refused`)
  reads "The tool didn't run.", and any other error result's reads "The call
  returned an error, and this notice can't say whether the tool ran.",
  followed, when its original was written to a workspace file, by "Read it
  before calling again." The stub, the retry and the placeholder sent when the
  guard's audit can't be saved all carry the same notice.
