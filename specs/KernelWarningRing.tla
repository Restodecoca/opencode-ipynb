---------------- MODULE KernelWarningRing ----------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Capacity, Messages, ClearThreshold

VARIABLES seen, ring, ringEpochs, delivered, epochs

Init ==
  /\ seen = {}
  /\ ring = <<>>
  /\ ringEpochs = <<>>
  /\ delivered = 0
  /\ epochs = 0

\* Mirrors KernelManager.record: the dedup check comes first, then the
\* anti-leak clear when the set has reached its threshold, then the add.
\* The TS clears the dedup set in place, so a message recorded in an
\* earlier epoch can be delivered again; the epoch counters make that
\* behavior explicit instead of forbidding it.
Record(m) ==
  /\ m \in Messages
  /\ m \notin seen
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
  /\ m \notin seen
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

Duplicate(m) ==
  /\ m \in seen
  /\ UNCHANGED <<seen, ring, ringEpochs, delivered, epochs>>

Next ==
  \/ \E m \in Messages : Record(m)
  \/ \E m \in Messages : RecordAfterClear(m)
  \/ \E m \in Messages : Duplicate(m)

Spec == Init /\ [][Next]_<<seen, ring, ringEpochs, delivered, epochs>>

TypeOK ==
  /\ ring \in Seq(Messages)
  /\ Len(ring) <= Capacity
  /\ seen \subseteq Messages
  /\ Cardinality(seen) <= ClearThreshold
  /\ Len(ringEpochs) = Len(ring)
  /\ \A i \in 1..Len(ringEpochs) : ringEpochs[i] \in Nat
  /\ \A i \in 1..Len(ringEpochs) : ringEpochs[i] <= epochs
  /\ delivered \in Nat
  /\ epochs \in Nat

StateConstraint ==
  epochs <= 2

Bounded ==
  [][Len(ring) <= Capacity]_ring

\* Within one epoch the dedup set still holds, so the ring cannot hold
\* the same message twice; across epochs it can, and that is honest.
NoDuplicatesWithinEpoch ==
  \A i, j \in 1..Len(ring) :
    (ring[i] = ring[j] /\ ringEpochs[i] = ringEpochs[j]) => i = j

\* The delivered history is bounded by what is still deduplicated plus
\* one full threshold window per clear.
\* The anti-leak clear bounds how many messages survive between clears. This
\* invariant alone does NOT pin that the clear happens: if `seen` never clears,
\* it grows and the bound still holds. NoDuplicatesWithinEpoch is what pins the
\* ring's shape, and the twin demonstrates why both are needed.
DeliveredBounded ==
  delivered <= Cardinality(seen) + ClearThreshold * epochs

=====================================
