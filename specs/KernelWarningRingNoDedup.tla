---------------- MODULE KernelWarningRingNoDedup ----------------
EXTENDS Naturals, Sequences, FiniteSets

\* Dishonest twin of KernelWarningRing: `record` forgets the dedup check,
\* so the same message is delivered again inside one epoch and the ring can
\* hold it twice. NotebookWarningRing's NoDuplicatesWithinEpoch is the
\* property this twin violates.

CONSTANTS Capacity, Messages, ClearThreshold

VARIABLES seen, ring, ringEpochs, delivered, epochs

Init ==
  /\ seen = {}
  /\ ring = <<>>
  /\ ringEpochs = <<>>
  /\ delivered = 0
  /\ epochs = 0

Record(m) ==
  /\ m \in Messages
  /\ Cardinality(seen) < ClearThreshold
  /\ seen' = seen \union {m}
  /\ ring' = IF Len(ring) >= Capacity
               THEN Tail(ring) \o <<m>>
               ELSE Append(ring, m)
  /\ ringEpochs' = IF Len(ringEpochs) >= Capacity
                     THEN Tail(ringEpochs) \o <<epochs>>
                     ELSE Append(ringEpochs, epochs)
  /\ delivered' = delivered + 1
  /\ UNCHANGED epochs

RecordAfterClear(m) ==
  /\ m \in Messages
  /\ Cardinality(seen) >= ClearThreshold
  /\ seen' = {m}
  /\ epochs' = epochs + 1
  /\ ring' = IF Len(ring) >= Capacity
               THEN Tail(ring) \o <<m>>
               ELSE Append(ring, m)
  /\ ringEpochs' = IF Len(ringEpochs) >= Capacity
                     THEN Tail(ringEpochs) \o <<epochs'>>
                     ELSE Append(ringEpochs, epochs')
  /\ delivered' = delivered + 1

Next ==
  \/ \E m \in Messages : Record(m)
  \/ \E m \in Messages : RecordAfterClear(m)

Spec == Init /\ [][Next]_<<seen, ring, ringEpochs, delivered, epochs>>

TypeOK ==
  /\ ring \in Seq(Messages)
  /\ Len(ring) <= Capacity
  /\ seen \subseteq Messages
  /\ Cardinality(seen) <= ClearThreshold
  /\ Len(ringEpochs) = Len(ring)
  /\ delivered \in Nat
  /\ epochs \in Nat

StateConstraint ==
  epochs <= 2

NoDuplicatesWithinEpoch ==
  \A i, j \in 1..Len(ring) :
    (ring[i] = ring[j] /\ ringEpochs[i] = ringEpochs[j]) => i = j

=====================================
