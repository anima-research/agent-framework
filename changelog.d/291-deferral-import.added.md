- A store left by a release that still had writes in its deferred queue boots and stores each of them once (#291,
  for one release). `create()` reads the queue's record (`recovery/deferred-writes.json`, or the store's
  `framework/deferred-writes` slot), after the quiesced flags and before the boot's pass over the windows and the
  agent registry's reconcile, and stores its writes in the order they arrived, each under its queued id
  (`metadata.deferredWriteId`), with a `message:added` trace whose source is `deferred-import`. A write that already
  landed is skipped by that id, and one whose landing was unknown is looked up across its agent's whole branch
  first. A write keeps the audience stamp it was queued with; one queued before the stamp is stamped as any write,
  and a puppeted tool-call pair as its agent's own round. A write for an agent no longer registered goes to the
  primary as its by-name notice, stamped for the primary alone whatever stamp it was queued with, when it is a
  failed reply, a channel notice its reader could act on, or a module's write for a run or a fork; anything else is
  dropped, logged. A tune-out's release among them wakes its agent, and mail among them is released as it is stored
  and wakes its recipient. The store is synced, and only then is the record cleared; where it doesn't sync, the
  record is left as it was and the next boot skips what landed. A write that can't be stored, or whose agent's store
  can't be searched, keeps it and that agent's later writes in the record for the next boot. An unreadable record,
  or one that holds anything but a queue, still fails `create()`. The imported rows enter each agent's window at the
  boot's pass, or at `resume()` on a quiesced host, apart from an agent's own rows.
- A tune-out's release for the resident, and its notices for the subconscious, are stored at once and made durable
  as before, but the wake each asks for is in memory. At boot, such a row still out of its agent's window (stored
  while a turn of the agent's was alive, the process ending before the turn did) asks its agent's wake again
  (`tune-out released (restored)` for the resident, `tune-out (restored)` for the subconscious), as the restored
  queue did in earlier releases (#232 gap 6).
- Mail (a job's result, an agent's message) is stored for its recipient as it is delivered, whatever the recipient's
  turn, and its hold is released once the store has synced the row; the wake the delivery asks for is in memory. At
  boot, mail stored for an agent and still out of its window (it arrived during a turn the process ended before
  finishing) wakes that agent again, once per sender and kind (`agent-result:<sender>`, `agent-message:<sender>`,
  source `dendrite`), before the boot's pass presents it. Earlier releases kept such mail held while its write
  waited, and the boot's redelivery woke the recipient. An interrupted job whose result is stored this way still
  tells its recipient nothing about ending without a result.
