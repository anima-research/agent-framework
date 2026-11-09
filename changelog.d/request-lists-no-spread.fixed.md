- **Held wakes and judged events past what a call can take as arguments
  no longer throw.** V8 throws a `RangeError` when a call passes more than
  about 125,000 arguments, and the framework spread lists into calls such
  as `push(...list)` and `Math.min(...list)`. A provider hold that held
  that many wakes threw as it released them, and a judge rule's quiet
  period that gathered that many events threw when its batch met one
  already held for a running turn or one with the judge. Every call that
  spread a list that can grow that long with what an agent holds or does
  now passes it without a spread.
