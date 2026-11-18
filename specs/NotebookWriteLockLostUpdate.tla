---------------- MODULE NotebookWriteLockLostUpdate ----------------
EXTENDS Naturals

\* The dishonest twin of NotebookWriteLock: the writer releases and
\* writes without rechecking the version it captured at acquire.

CONSTANTS Writers, None

VARIABLES holder, disk, revision, running, finished, wrote, stale

Init ==
  /\ holder = None
  /\ disk = 0
  /\ revision = 0
  /\ running = Writers
  /\ finished = {}
  /\ wrote = {}
  /\ stale = [w \in Writers |-> FALSE]

Acquire(w) ==
  /\ w \in running
  /\ holder = None
  /\ holder' = w
  /\ revision' = disk
  /\ stale' = [stale EXCEPT ![w] = FALSE]
  /\ UNCHANGED <<disk, running, finished, wrote>>

WriteWithoutRecheck(w) ==
  /\ holder = w
  /\ disk' = disk + 1
  /\ holder' = None
  /\ running' = running \ {w}
  /\ finished' = finished \union {w}
  /\ wrote' = wrote \union {w}
  /\ UNCHANGED <<revision, stale>>

ExternalWrite ==
  /\ disk' = disk + 1
  /\ stale' = IF holder = None
                THEN stale
                ELSE [stale EXCEPT ![holder] = TRUE]
  /\ UNCHANGED <<holder, revision, running, finished, wrote>>

Next ==
  \/ \E w \in running : Acquire(w)
  \/ \E w \in running : WriteWithoutRecheck(w)
  \/ ExternalWrite

Spec == Init /\ [][Next]_<<holder, disk, revision, running, finished, wrote, stale>>

TypeOK ==
  /\ holder \in (Writers \union {None})
  /\ running \subseteq Writers
  /\ finished \subseteq Writers
  /\ wrote \subseteq finished
  /\ running \intersect finished = {}
  /\ disk \in Nat
  /\ revision \in Nat
  /\ stale \in [Writers -> BOOLEAN]

StateConstraint ==
  /\ disk <= 3
  /\ revision <= 3

NoLostUpdate ==
  \A w \in wrote : stale[w] = FALSE

=====================================
