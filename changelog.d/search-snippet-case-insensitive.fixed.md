- **`history--search`'s snippet for a case-insensitive match now always
  holds the match.** The search found the match in the lower-cased text but
  cut the snippet from the text itself at the same position. `İ` (U+0130)
  lower-cases to two UTF-16 units, so each one before a match made the
  match's index in the text one unit too large, and enough of them left the
  match outside the snippet. The snippet now sits on the match in the text
  itself.
