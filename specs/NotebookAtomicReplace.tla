---------------- MODULE NotebookAtomicReplace ----------------
\* Scope: this models ONLY the win32 branch of utils/atomic-replace.ts. On
\* POSIX the module returns after the first rename (or rethrows), so the
\* backup/restore/cleanup states below are unreachable there: the POSIX
\* protocol is the DirectOk / DirectFailRaise pair. A POSIX deployment of this
\* spec would be a much smaller model, not this one.
EXTENDS Naturals

VARIABLES phase, target, backup, temp, raised, warned

Init ==
  /\ phase = "start"
  /\ target = "old"
  /\ backup = "absent"
  /\ temp = "new"
  /\ raised = FALSE
  /\ warned = FALSE

DirectOk ==
  /\ phase = "start"
  /\ phase' = "done"
  /\ target' = "new"
  /\ temp' = "absent"
  /\ UNCHANGED <<backup, raised, warned>>

DirectFailRaise ==
  /\ phase = "start"
  /\ phase' = "done"
  /\ raised' = TRUE
  /\ UNCHANGED <<target, backup, temp, warned>>

DirectFailRetry ==
  /\ phase = "start"
  /\ phase' = "retrying"
  /\ UNCHANGED <<target, backup, temp, raised, warned>>

BackupOk ==
  /\ phase = "retrying"
  /\ phase' = "retry"
  /\ backup' = "old"
  /\ target' = "absent"
  /\ UNCHANGED <<temp, raised, warned>>

BackupFail ==
  /\ phase = "retrying"
  /\ phase' = "retry"
  /\ warned' = TRUE
  /\ UNCHANGED <<target, backup, temp, raised>>

MoveOk ==
  /\ phase = "retry"
  /\ phase' = "moved"
  /\ target' = "new"
  /\ temp' = "absent"
  /\ UNCHANGED <<backup, raised, warned>>

MoveFailWithBackup ==
  /\ phase = "retry"
  /\ backup = "old"
  /\ phase' = "restoring"
  /\ UNCHANGED <<target, backup, temp, raised, warned>>

MoveFailNoBackup ==
  /\ phase = "retry"
  /\ backup = "absent"
  /\ phase' = "done"
  /\ raised' = TRUE
  /\ UNCHANGED <<target, backup, temp, warned>>

RestoreOk ==
  /\ phase = "restoring"
  /\ phase' = "done"
  /\ backup' = "absent"
  /\ target' = "old"
  /\ raised' = TRUE
  /\ UNCHANGED <<temp, warned>>

RestoreFail ==
  /\ phase = "restoring"
  /\ phase' = "done"
  /\ raised' = TRUE
  /\ warned' = TRUE
  /\ UNCHANGED <<target, backup, temp>>

CleanupOk ==
  /\ phase = "moved"
  /\ backup = "old"
  /\ phase' = "done"
  /\ backup' = "absent"
  /\ UNCHANGED <<target, temp, raised, warned>>

CleanupFail ==
  /\ phase = "moved"
  /\ backup = "old"
  /\ phase' = "done"
  /\ warned' = TRUE
  /\ UNCHANGED <<target, backup, temp, raised>>

FinishNoBackup ==
  /\ phase = "moved"
  /\ backup = "absent"
  /\ phase' = "done"
  /\ UNCHANGED <<target, backup, temp, raised, warned>>

Next ==
  \/ DirectOk
  \/ DirectFailRaise
  \/ DirectFailRetry
  \/ BackupOk
  \/ BackupFail
  \/ MoveOk
  \/ MoveFailWithBackup
  \/ MoveFailNoBackup
  \/ RestoreOk
  \/ RestoreFail
  \/ CleanupOk
  \/ CleanupFail
  \/ FinishNoBackup

Spec == Init /\ [][Next]_<<phase, target, backup, temp, raised, warned>>

TypeOK ==
  /\ phase \in {"start", "retrying", "retry", "moved", "restoring", "done"}
  /\ target \in {"old", "new", "absent"}
  /\ backup \in {"old", "absent"}
  /\ temp \in {"new", "absent"}
  /\ raised \in BOOLEAN
  /\ warned \in BOOLEAN

TargetNeverPartial ==
  target \in {"old", "new", "absent"}

DoneSuccess ==
  phase = "done" => (raised = FALSE => target = "new")

RaisedKeepsOriginal ==
  phase = "done" /\ raised => target = "old" \/ backup = "old"

NoSilentVanish ==
  phase = "done" /\ target = "absent" => raised

LeftoverBackupAnnounced ==
  phase = "done" /\ backup = "old" => warned

OrphanTempRaised ==
  phase = "done" /\ temp = "new" => raised

=============================================================================
