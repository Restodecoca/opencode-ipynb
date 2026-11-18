namespace OpencodeIpynb

structure Edit where
  start : Nat
  stop : Nat
  text : List Char

def applyEditsFrom (text : List Char) (cursor : Nat) : List Edit → Option (List Char)
  | [] => some (text.drop cursor)
  | edit :: rest =>
      if edit.start < cursor then none
      else
        match applyEditsFrom text edit.stop rest with
        | none => none
        | some tail =>
            some ((text.drop cursor).take (edit.start - cursor) ++ edit.text ++ tail)

def applyEdits (text : List Char) (edits : List Edit) : Option (List Char) :=
  applyEditsFrom text 0 edits

def chainedFrom (cursor : Nat) : List Edit → Bool
  | [] => true
  | edit :: rest => decide (cursor ≤ edit.start) && chainedFrom edit.stop rest

theorem chainedFrom_cons (cursor : Nat) (edit : Edit) (rest : List Edit)
    (h : chainedFrom cursor (edit :: rest) = true) :
    cursor ≤ edit.start ∧ chainedFrom edit.stop rest = true := by
  simp [chainedFrom] at h
  exact h

theorem applyEdits_nil (text : List Char) : applyEdits text [] = some text := by
  simp [applyEdits, applyEditsFrom]

theorem applyEdits_single (text : List Char) (edit : Edit) :
    applyEdits text [edit] =
      some (text.take edit.start ++ edit.text ++ text.drop edit.stop) := by
  simp only [applyEdits, applyEditsFrom]
  rw [ite_eq_right (by omega : ¬ (edit.start < 0))]
  simp

theorem applyEdits_overlap_rejected (text : List Char) (e1 e2 : Edit)
    (_hsorted : e1.start ≤ e2.start) (hoverlap : e2.start < e1.stop) :
    applyEdits text [e1, e2] = none := by
  simp only [applyEdits, applyEditsFrom]
  rw [ite_eq_right (by omega : ¬ (e1.start < 0))]
  rw [ite_eq_left hoverlap]

theorem applyEdits_two (text : List Char) (e1 e2 : Edit)
    (_hvalid1 : e1.start ≤ e1.stop) (_hvalid2 : e2.start ≤ e2.stop)
    (h : e1.stop ≤ e2.start) :
    applyEdits text [e1, e2] =
      some (text.take e1.start ++ e1.text ++
        ((text.drop e1.stop).take (e2.start - e1.stop) ++ e2.text ++ text.drop e2.stop)) := by
  simp only [applyEdits, applyEditsFrom]
  rw [ite_eq_right (by omega : ¬ (e1.start < 0))]
  rw [ite_eq_right (by omega : ¬ (e2.start < e1.stop))]
  simp

def spliceAll (text : List Char) (cursor : Nat) : List Edit → List Char
  | [] => text.drop cursor
  | edit :: rest =>
      (text.drop cursor).take (edit.start - cursor) ++ edit.text ++
        spliceAll text edit.stop rest

theorem applyEditsFrom_eq_spliceAll (text : List Char) (cursor : Nat) :
    ∀ edits : List Edit, chainedFrom cursor edits = true →
      applyEditsFrom text cursor edits = some (spliceAll text cursor edits) := by
  intro edits
  induction edits generalizing cursor with
  | nil => intro _; simp [applyEditsFrom, spliceAll]
  | cons edit rest ih =>
      intro h
      obtain ⟨hle, hchain⟩ := chainedFrom_cons cursor edit rest h
      simp only [applyEditsFrom]
      rw [ite_eq_right (by omega : ¬ (edit.start < cursor))]
      rw [ih edit.stop hchain]
      simp [spliceAll]

theorem applyEdits_chained_total (text : List Char) (edits : List Edit)
    (_hvalid : ∀ e ∈ edits, e.start ≤ e.stop)
    (h : chainedFrom 0 edits = true) :
    applyEdits text edits = some (spliceAll text 0 edits) :=
  applyEditsFrom_eq_spliceAll text 0 edits h

end OpencodeIpynb
