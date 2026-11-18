---------------- MODULE NotebookWriteLock ----------------
EXTENDS Naturals

CONSTANTS Writers, None

VARIABLES holder, disk, revision, running, finished

Init ==
  /\ holder = None
  /\ disk = 0
  /\ revision = 0
  /\ running = Writers
  /\ finished = {}

Acquire(w) ==
  /\ w \in running
  /\ holder = None
  /\ holder' = w
  /\ UNCHANGED <<disk, revision, running, finished>>

WriteChecked(w) ==
  /\ holder = w
  /\ disk = revision
  /\ disk' = disk + 1
  /\ revision' = disk'
  /\ holder' = None
  /\ running' = running \ {w}
  /\ finished' = finished \union {w}

ExternalWrite ==
  /\ holder = None
  /\ disk' = disk + 1
  /\ revision' = revision
  /\ UNCHANGED <<holder, running, finished>>

Next ==
  \/ \E w \in running : Acquire(w)
  \/ \E w \in running : WriteChecked(w)
  \/ ExternalWrite

Spec == Init /\ [][Next]_<<holder, disk, revision, running, finished>>

TypeOK ==
  /\ holder \in (Writers \union {None})
  /\ running \subseteq Writers
  /\ finished \subseteq Writers
  /\ running \intersect finished = {}

StateConstraint ==
  /\ disk <= 3
  /\ revision <= 3

MutualExclusion ==
  \A w1, w2 \in Writers : holder = w1 /\ holder = w2 => w1 = w2

StaleWriteImpossible ==
  [][ \A w \in Writers : WriteChecked(w) => disk = revision ]_<<disk, revision>>

=============================================================================
