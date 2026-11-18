---------------- MODULE NotebookExecutionSave ----------------
EXTENDS Naturals

\* SaveChecked collapses the under-lock re-read, the hash comparison,
\* and the atomic rename into a single step. That check-to-rename
\* atomicity is this model's stated assumption: the plugin-internal
\* file lock serializes plugin writers, but a non-cooperating external
\* writer keeps a residual window after the final read that no
\* in-process protocol can close. ExternalWrite stays enabled after a
\* save for the same reason.

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

SaveChecked ==
  /\ stage = "executing"
  /\ disk = snapshot
  /\ disk' = disk + 1
  /\ savedVersion' = disk'
  /\ stage' = "saved"
  /\ UNCHANGED snapshot

SaveAborted ==
  /\ stage = "executing"
  /\ disk /= snapshot
  /\ stage' = "aborted"
  /\ UNCHANGED <<disk, snapshot, savedVersion>>

Next ==
  \/ ReadSnapshot
  \/ ExternalWrite
  \/ SaveChecked
  \/ SaveAborted

Spec == Init /\ [][Next]_<<stage, snapshot, disk, savedVersion>>

TypeOK ==
  /\ stage \in {"idle", "executing", "saved", "aborted"}
  /\ snapshot \in Nat
  /\ disk \in Nat
  /\ savedVersion \in Nat

StateConstraint ==
  disk <= 3

\* A completed save wrote exactly the snapshotted version plus the save
\* itself; the recheck guard is what keeps this true, and the
\* NotebookExecutionSaveNoRecheck twin violates it.
SavedVersionMatches ==
  stage = "saved" => savedVersion = snapshot + 1

=====================================
