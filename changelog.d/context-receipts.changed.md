- **Tool consumers:** `channel_list` now returns `{ channels }` instead of a
  bare array of channels, with `receiptClocks` beside them and `clocks` on
  each channel entry when the clocks are wired, as they are in the framework.
  Nothing in this repository or connectome-host parsed the old shape.
