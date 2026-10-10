- **Tool consumers:** `channel_list` now returns `{ channels, receiptClocks }`
  instead of a bare array of channels. Each channel entry gains `clocks`.
  Nothing in this repository or connectome-host parsed the old shape.
