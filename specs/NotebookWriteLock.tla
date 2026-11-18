---------------- MODULE NotebookWriteLock ----------------
EXTENDS Naturals, FiniteSets

CONSTANTS Writers, None

\* ExternalWrite stays enabled even while a writer holds the lock: the
\* file lock is an in-process semaphore and an external writer such as
\* Jupyter never takes it. WriteChecked collapses the recheck, the
\* write, and the rename into one step, so the check-to-rename window
\* against a non-cooperating external writer is the same stated
\* assumption as in NotebookExecutionSave. AbortChecked is the honest
\* exit when the recheck sees an update that landed mid-window.

VARIABLES holder, held, disk, revision, running, finished, wrote, stale

Init ==
  /\ holder = None
  /\ held = {}
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
  /\ held' = held \union {w}
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
  /\ held' = held \ {w}
  /\ UNCHANGED <<revision, stale>>

AbortChecked(w) ==
  /\ holder = w
  /\ disk /= revision
  /\ holder' = None
  /\ running' = running \ {w}
  /\ finished' = finished \union {w}
  /\ held' = held \ {w}
  /\ UNCHANGED <<disk, revision, wrote, stale>>

ExternalWrite ==
  /\ disk' = disk + 1
  /\ stale' = IF holder = None
                THEN stale
                ELSE [stale EXCEPT ![holder] = TRUE]
  /\ UNCHANGED <<holder, revision, running, finished, wrote, held>>

Next ==
  \/ \E w \in running : Acquire(w)
  \/ \E w \in running : WriteChecked(w)
  \/ \E w \in running : AbortChecked(w)
  \/ ExternalWrite

Spec == Init /\ [][Next]_<<holder, held, disk, revision, running, finished, wrote, stale>>

TypeOK ==
  /\ holder \in (Writers \union {None})
  /\ running \subseteq Writers
  /\ finished \subseteq Writers
  /\ wrote \subseteq finished
  /\ running \intersect finished = {}
  /\ held \subseteq Writers
  /\ disk \in Nat
  /\ revision \in Nat
  /\ stale \in [Writers -> BOOLEAN]

StateConstraint ==
  /\ disk <= 3
  /\ revision <= 3

MutualExclusion ==
  Cardinality(held) <= 1

HolderMatchesHeld ==
  holder = None <=> held = {}

\* Every completed write saw the same disk version at its check as at
\* its acquire, so no external update was clobbered on the way. The
\* NotebookWriteLockLostUpdate twin violates this.
NoLostUpdate ==
  \A w \in wrote : stale[w] = FALSE

=====================================
