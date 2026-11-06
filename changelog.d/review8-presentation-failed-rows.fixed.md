- `presentation:failed` names the rows that stay out of the agent's window (`messageIds`) where they are known, and
  its log line counts and names them (#291).
- A presentation whose write the store accepted counts its rows as presented even when a read of the window throws
  right after: it is traced (`presentation:presented`), its listeners hear the rows, and no `presentation:failed` is
  traced for it. Before, that read's throw left the rows in the window untold (#291).
