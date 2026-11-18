---------------- MODULE NotebookWriteLock ----------------
EXTENDS Naturals

CONSTANTS Writers, None

\* ExternalWrite stays enabled even while a writer holds the lock: the
\* file lock is an in-process semaphore and an external writer such as
\* Jupyter never takes it. The recheck inside WriteChecked is the only
\* defense against an update that lands mid-window, and AbortChecked is
\* the honest exit when that defense fires.

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

WriteChecked(w) ==
  /\ holder = w
  /\ disk = revision
  /\ disk' = disk + 1
  /\ holder' = None
  /\ running' = running \ {w}
  /\ finished' = finished \union {w}
  /\ wrote' = wrote \union {w}
  /\ UNCHANGED <<revision, stale>>

AbortChecked(w) ==
  /\ holder = w
  /\ disk /= revision
  /\ holder' = None
  /\ running' = running \ {w}
  /\ finished' = finished \union {w}
  /\ UNCHANGED <<disk, revision, wrote, stale>>

ExternalWrite ==
  /\ disk' = disk + 1
  /\ stale' = IF holder = None
                THEN stale
                ELSE [stale EXCEPT ![holder] = TRUE]
  /\ UNCHANGED <<holder, revision, running, finished, wrote>>

Next ==
  \/ \E w \in running : Acquire(w)
  \/ \E w \in running : WriteChecked(w)
  \/ \E w \in running : AbortChecked(w)
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

MutualExclusion ==
  \A w1, w2 \in Writers : holder = w1 /\ holder = w2 => w1 = w2

\* Every completed write saw the same disk version at its check as at
\* its acquire, so no external update was clobbered on the way. The
\* NotebookWriteLockLostUpdate twin violates this.
NoLostUpdate ==
  \A w \in wrote : stale[w] = FALSE

=====================================
