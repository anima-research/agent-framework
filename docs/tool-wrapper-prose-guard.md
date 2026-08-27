# Tool-wrapper prose containment

`toolWrapperProseGuard: true` is a default-off per-agent safety boundary for a narrow failure mode: the provider emits a complete textual rendering of a tool invocation instead of a structured `tool_use` block.

The guard matches only when the entire visible prose is one wrapper naming a tool registered on that exact inference. Signed thinking may precede the visible wrapper. It does not parse or execute the wrapper body.

Guarded turns buffer prose until completion so outgoing preview/voice surfaces cannot expose a wrapper before classification. Ordinary non-wrapper prose is then delivered normally at turn completion.

On a match, Agent Framework:

- does not execute a tool;
- does not publish the wrapper;
- does not store the wrapper as assistant continuity;
- stores a fixed model-visible system receipt saying only that no tool was called; the tool name remains in metadata/host diagnostics, not prose;
- leaves the exact provider response in the host's inference trace/ledger.

The guard does not match unknown tools, quotation, code fences, mixed prose, partial wrappers, or any turn that executed a genuine structured call; trailing prose after a real tool round remains ordinary history. It is containment rather than a prose-to-tool parser.
