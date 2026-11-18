---------------- MODULE NotebookExecutionSave ----------------
EXTENDS Naturals

VARIABLES stage, snapshot, disk, lastSaveStale

Init ==
  /\ stage = "idle"
  /\ snapshot = 0
  /\ disk = 0
  /\ lastSaveStale = FALSE

ReadSnapshot ==
  /\ stage = "idle"
  /\ snapshot' = disk
  /\ stage' = "executing"
  /\ UNCHANGED <<disk, lastSaveStale>>

ExternalWrite ==
  /\ disk' = disk + 1
  /\ UNCHANGED <<stage, snapshot, lastSaveStale>>

SaveChecked ==
  /\ stage = "executing"
  /\ disk = snapshot
  /\ disk' = disk + 1
  /\ stage' = "saved"
  /\ lastSaveStale' = FALSE
  /\ UNCHANGED snapshot

SaveAborted ==
  /\ stage = "executing"
  /\ disk /= snapshot
  /\ stage' = "aborted"
  /\ UNCHANGED <<disk, snapshot, lastSaveStale>>

Next ==
  \/ ReadSnapshot
  \/ ExternalWrite
  \/ SaveChecked
  \/ SaveAborted

Spec == Init /\ [][Next]_<<stage, snapshot, disk, lastSaveStale>>

TypeOK ==
  /\ stage \in {"idle", "executing", "saved", "aborted"}
  /\ snapshot \in Nat
  /\ disk \in Nat
  /\ lastSaveStale \in BOOLEAN

StateConstraint ==
  disk <= 3

NoStaleSave ==
  lastSaveStale = FALSE

=============================================================================
