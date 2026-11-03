- The arrivals a rollback holds out of an agent's window until its next turn start are held on the rollback's
  branch only (#291). After a move to another branch before that start, the same stored rows are presented there as
  any arrival is; back on the rollback's branch, the hold applies again until the start. Before, the hold followed
  the agent to the other branch and kept them out there at rest.
