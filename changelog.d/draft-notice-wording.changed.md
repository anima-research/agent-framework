- The held-draft notice now says, in one full sentence, which drafts it
  holds, how long each is, and why: "your plain-speech message (42 chars) was
  not sent and is instead held as draft d-… because you made an explicit send
  in this round or an earlier one this turn". Several drafts are named in the
  order they were written. The notice itself quotes none of a draft's words:
  the drafts tool's `read` shows them.
- A draft held by an explicit send now gives the same cause wherever it's
  shown. The notice, the drafts tool's listing and `read`, and the catch-up
  notice said the send was in "the same round", though a send also holds
  back plain speech in the turn's later rounds, until new input arrives or a
  budget restart starts a new stream, and in XML tool mode, which routes no
  round live, in every round of the turn. The listing and the catch-up notice
  now say "explicit send in its turn", and `read` says "an explicit send in
  its turn held it back". The listing keeps its preview
  of each draft's opening words, and the drafts tool's own description is
  unchanged.
