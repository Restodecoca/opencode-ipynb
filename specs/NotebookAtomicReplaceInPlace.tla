---------------- MODULE NotebookAtomicReplaceInPlace ----------------
EXTENDS Naturals

VARIABLES phase, target

Init ==
  /\ phase = "writing"
  /\ target = "old"

BeginInPlace ==
  /\ phase = "writing"
  /\ target = "old"
  /\ target' = "partial"
  /\ UNCHANGED phase

FinishInPlace ==
  /\ phase = "writing"
  /\ target = "partial"
  /\ phase' = "done"
  /\ target' = "new"

Next ==
  \/ BeginInPlace
  \/ FinishInPlace

Spec == Init /\ [][Next]_<<phase, target>>

TypeOK ==
  /\ phase \in {"writing", "done"}
  /\ target \in {"old", "partial", "new"}

TargetNeverPartial ==
  target # "partial"

=============================================================================
