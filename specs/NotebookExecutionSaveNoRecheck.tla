---------------- MODULE NotebookExecutionSaveNoRecheck ----------------
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

SaveWithoutRecheck ==
  /\ stage = "executing"
  /\ disk' = disk + 1
  /\ stage' = "saved"
  /\ lastSaveStale' = (disk /= snapshot)
  /\ UNCHANGED snapshot

Next ==
  \/ ReadSnapshot
  \/ ExternalWrite
  \/ SaveWithoutRecheck

Spec == Init /\ [][Next]_<<stage, snapshot, disk, lastSaveStale>>

TypeOK ==
  /\ stage \in {"idle", "executing", "saved"}
  /\ snapshot \in Nat
  /\ disk \in Nat
  /\ lastSaveStale \in BOOLEAN

StateConstraint ==
  disk <= 3

NoStaleSave ==
  lastSaveStale = FALSE

=============================================================================
