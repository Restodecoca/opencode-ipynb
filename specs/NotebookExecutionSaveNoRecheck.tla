---------------- MODULE NotebookExecutionSaveNoRecheck ----------------
EXTENDS Naturals

\* The dishonest twin of NotebookExecutionSave: the save skips the
\* under-lock recheck and lands whatever version it likes.

VARIABLES stage, snapshot, disk, savedVersion

Init ==
  /\ stage = "idle"
  /\ snapshot = 0
  /\ disk = 0
  /\ savedVersion = 0

ReadSnapshot ==
  /\ stage = "idle"
  /\ snapshot' = disk
  /\ stage' = "executing"
  /\ UNCHANGED <<disk, savedVersion>>

ExternalWrite ==
  /\ disk' = disk + 1
  /\ UNCHANGED <<stage, snapshot, savedVersion>>

SaveWithoutRecheck ==
  /\ stage = "executing"
  /\ disk' = disk + 1
  /\ savedVersion' = disk'
  /\ stage' = "saved"
  /\ UNCHANGED snapshot

Next ==
  \/ ReadSnapshot
  \/ ExternalWrite
  \/ SaveWithoutRecheck

Spec == Init /\ [][Next]_<<stage, snapshot, disk, savedVersion>>

TypeOK ==
  /\ stage \in {"idle", "executing", "saved"}
  /\ snapshot \in Nat
  /\ disk \in Nat
  /\ savedVersion \in Nat

StateConstraint ==
  disk <= 3

SavedVersionMatches ==
  stage = "saved" => savedVersion = snapshot + 1

=====================================
