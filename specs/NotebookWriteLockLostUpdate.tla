---------------- MODULE NotebookWriteLockLostUpdate ----------------
EXTENDS Naturals

CONSTANTS Writers, None

VARIABLES holder, disk, revision, running, finished, lostUpdate

Init ==
  /\ holder = None
  /\ disk = 0
  /\ revision = 0
  /\ running = Writers
  /\ finished = {}
  /\ lostUpdate = FALSE

Acquire(w) ==
  /\ w \in running
  /\ holder = None
  /\ holder' = w
  /\ UNCHANGED <<disk, revision, running, finished, lostUpdate>>

WriteWithoutRecheck(w) ==
  /\ holder = w
  /\ disk' = disk + 1
  /\ revision' = disk
  /\ lostUpdate' = (revision /= disk)
  /\ holder' = None
  /\ running' = running \ {w}
  /\ finished' = finished \union {w}

ExternalWrite ==
  /\ holder = None
  /\ disk' = disk + 1
  /\ revision' = revision
  /\ UNCHANGED <<holder, running, finished, lostUpdate>>

Next ==
  \/ \E w \in running : Acquire(w)
  \/ \E w \in running : WriteWithoutRecheck(w)
  \/ ExternalWrite

Spec == Init /\ [][Next]_<<holder, disk, revision, running, finished, lostUpdate>>

TypeOK ==
  /\ holder \in (Writers \union {None})
  /\ running \subseteq Writers
  /\ finished \subseteq Writers
  /\ disk \in Nat
  /\ revision \in Nat

StateConstraint ==
  /\ disk <= 3
  /\ revision <= 3

NoLostUpdate ==
  lostUpdate = FALSE

=============================================================================
