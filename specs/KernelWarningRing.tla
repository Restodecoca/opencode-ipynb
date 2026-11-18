---------------- MODULE KernelWarningRing ----------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Capacity, Messages

VARIABLES seen, ring, delivered

Init ==
  /\ seen = {}
  /\ ring = <<>>
  /\ delivered = 0

Record(m) ==
  /\ m \in Messages
  /\ m \notin seen
  /\ seen' = seen \union {m}
  /\ ring' = IF Len(ring) >= Capacity
              THEN Tail(ring) \o <<m>>
              ELSE Append(ring, m)
  /\ delivered' = delivered + 1

Duplicate(m) ==
  /\ m \in seen
  /\ UNCHANGED <<seen, ring, delivered>>

Next ==
  \/ \E m \in Messages : Record(m)
  \/ \E m \in Messages : Duplicate(m)

Spec == Init /\ [][Next]_<<seen, ring, delivered>>

TypeOK ==
  /\ ring \in Seq(Messages)
  /\ Len(ring) <= Capacity
  /\ seen \subseteq Messages

Bounded ==
  [][Len(ring) <= Capacity]_ring

NoDuplicates ==
  \A i, j \in 1..Len(ring) : ring[i] = ring[j] => i = j

DeliveredOnce ==
  [][delivered <= Cardinality(seen)]_<<seen, delivered>>

=============================================================================
