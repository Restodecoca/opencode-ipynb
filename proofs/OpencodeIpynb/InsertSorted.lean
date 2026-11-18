namespace OpencodeIpynb

variable {α : Type} [BEq α] [LawfulBEq α]

def hasKey : List α → α → Bool
  | [], _ => false
  | k :: rest, key => if k == key then true else hasKey rest key

omit [LawfulBEq α] in
theorem hasKey_cons_true (k : α) (rest : List α) (key : α)
    (hk : (k == key) = true) : hasKey (k :: rest) key = true := by
  simp only [hasKey]
  rw [ite_eq_left hk]

omit [LawfulBEq α] in
theorem hasKey_cons_false (k : α) (rest : List α) (key : α)
    (hk : ¬ (k == key) = true) : hasKey (k :: rest) key = hasKey rest key := by
  simp only [hasKey]
  rw [ite_eq_right hk]

omit [LawfulBEq α] in
theorem hasKey_cons_tail_true (k : α) (rest : List α) (key : α)
    (hk : ¬ (k == key) = true) (hmem : hasKey rest key = true) :
    hasKey (k :: rest) key = true := by
  rw [hasKey_cons_false k rest key hk, hmem]

omit [LawfulBEq α] in
theorem hasKey_cons_inv (k : α) (rest : List α) (key : α)
    (h : hasKey (k :: rest) key = true) (hk : ¬ (k == key) = true) :
    hasKey rest key = true := by
  rw [hasKey_cons_false k rest key hk] at h
  exact h

def isSortedBy (lt : α → α → Bool) : List α → Bool
  | [] => true
  | [_] => true
  | a :: b :: rest => lt a b && isSortedBy lt (b :: rest)

def insertSortedAux (lt : α → α → Bool) (key : α) : List α → List α
  | [] => [key]
  | k :: rest =>
    if lt key k then key :: k :: rest else k :: insertSortedAux lt key rest

def insertSortedBy (lt : α → α → Bool) (present : List α → α → Bool)
    (keys : List α) (key : α) : List α :=
  if present keys key then keys
  else if isSortedBy lt keys then insertSortedAux lt key keys
  else keys ++ [key]

omit [BEq α] [LawfulBEq α] in
theorem insertSortedBy_noop (lt : α → α → Bool) (present : List α → α → Bool)
    (keys : List α) (key : α) (hmem : present keys key = true) :
    insertSortedBy lt present keys key = keys := by
  simp only [insertSortedBy]
  rw [ite_eq_left hmem]

omit [BEq α] [LawfulBEq α] in
theorem insertSortedBy_append (lt : α → α → Bool) (present : List α → α → Bool)
    (keys : List α) (key : α)
    (hnc : ¬ present keys key = true) (hns : ¬ isSortedBy lt keys = true) :
    insertSortedBy lt present keys key = keys ++ [key] := by
  simp only [insertSortedBy]
  rw [ite_eq_right hnc, ite_eq_right hns]

omit [BEq α] [LawfulBEq α] in
theorem insertSortedAux_positions (lt : α → α → Bool) (key : α) :
    ∀ keys : List α,
      ∃ pre post : List α,
        insertSortedAux lt key keys = pre ++ [key] ++ post ∧ keys = pre ++ post := by
  intro keys
  induction keys with
  | nil =>
    refine ⟨[], [], ?_, ?_⟩ <;> rfl
  | cons k rest ih =>
    obtain ⟨pre, post, hres, hrest⟩ := ih
    by_cases h : lt key k = true
    · refine ⟨[], k :: rest, ?_, ?_⟩
      · simp only [insertSortedAux]
        rw [ite_eq_left h]
        rfl
      · rfl
    · refine ⟨k :: pre, post, ?_, ?_⟩
      · simp only [insertSortedAux]
        rw [ite_eq_right h, hres]
        simp [List.cons_append]
      · rw [hrest]
        simp [List.cons_append]

omit [BEq α] [LawfulBEq α] in
theorem insertSortedBy_positions (lt : α → α → Bool) (present : List α → α → Bool)
    (keys : List α) (key : α) (hnc : ¬ present keys key = true) :
    ∃ pre post : List α,
      insertSortedBy lt present keys key = pre ++ [key] ++ post ∧ keys = pre ++ post := by
  simp only [insertSortedBy]
  by_cases hmem : present keys key = true
  · exact absurd hmem hnc
  · by_cases hsort : isSortedBy lt keys = true
    · rw [ite_eq_right hmem, ite_eq_left hsort]
      exact insertSortedAux_positions lt key keys
    · refine ⟨keys, [], ?_, ?_⟩
      · rw [ite_eq_right hmem, ite_eq_right hsort]
        simp
      · exact (List.append_nil keys).symm

omit [BEq α] [LawfulBEq α] in
theorem isSortedBy_cons_head (lt : α → α → Bool) (a b : α) (rest : List α) :
    isSortedBy lt (a :: b :: rest) = true → lt a b = true := by
  intro h
  simp [isSortedBy] at h
  exact h.1

omit [BEq α] [LawfulBEq α] in
theorem isSortedBy_cons_tail (lt : α → α → Bool) (a b : α) (rest : List α) :
    isSortedBy lt (a :: b :: rest) = true → isSortedBy lt (b :: rest) = true := by
  intro h
  simp [isSortedBy] at h
  exact h.2

theorem insertSortedAux_sorted (lt : α → α → Bool)
    (hconn : ∀ a b : α, ¬ lt a b = true → a = b ∨ lt b a = true)
    (key : α) :
    ∀ keys : List α,
      isSortedBy lt keys = true →
      ¬ hasKey keys key = true →
      isSortedBy lt (insertSortedAux lt key keys) = true := by
  intro keys
  induction keys with
  | nil => intro _ _; rfl
  | cons k rest ih =>
    intro hsorted hnc
    have hrestnc : ¬ hasKey rest key = true := by
      intro hmem
      cases hk : k == key with
      | true => exact absurd (hasKey_cons_true k rest key hk) hnc
      | false => exact absurd (hasKey_cons_tail_true k rest key (by simp [hk]) hmem) hnc
    by_cases h : lt key k = true
    · simp only [insertSortedAux]
      rw [ite_eq_left h]
      simp only [isSortedBy, Bool.and_eq_true]
      exact ⟨h, hsorted⟩
    · have hne : key ≠ k := by
        intro heq
        rw [heq] at hnc
        exact absurd (hasKey_cons_true k rest k (beq_self_eq_true k)) hnc
      have hklt : lt k key = true := by
        rcases hconn key k h with heq | hk
        · exact absurd heq hne
        · exact hk
      have hrestsorted : isSortedBy lt rest = true := by
        cases rest with
        | nil => simp [isSortedBy]
        | cons m ms => exact isSortedBy_cons_tail lt k m ms hsorted
      have htail := ih hrestsorted hrestnc
      cases rest with
      | nil =>
        simp only [insertSortedAux]
        rw [ite_eq_right h]
        simp only [isSortedBy, Bool.and_eq_true]
        refine ⟨hklt, ?_⟩
        simp
      | cons m ms =>
        by_cases hm : lt key m = true
        · simp only [insertSortedAux]
          rw [ite_eq_right h, ite_eq_left hm]
          simp only [isSortedBy, Bool.and_eq_true]
          exact ⟨hklt, hm, hrestsorted⟩
        · have hkm : lt k m = true := isSortedBy_cons_head lt k m ms hsorted
          have haux : insertSortedAux lt key (m :: ms) = m :: insertSortedAux lt key ms := by
            simp only [insertSortedAux]
            rw [ite_eq_right hm]
          have htail := ih hrestsorted hrestnc
          rw [haux] at htail
          simp only [insertSortedAux]
          rw [ite_eq_right h, ite_eq_right hm]
          simp only [isSortedBy, Bool.and_eq_true]
          exact ⟨hkm, htail⟩

theorem insertSortedBy_sorted (lt : α → α → Bool) (present : List α → α → Bool)
    (hsound : ∀ keys : List α, ∀ key : α, hasKey keys key = true → present keys key = true)
    (hconn : ∀ a b : α, ¬ lt a b = true → a = b ∨ lt b a = true)
    (keys : List α) (key : α)
    (hnc : ¬ present keys key = true) (hs : isSortedBy lt keys = true) :
    isSortedBy lt (insertSortedBy lt present keys key) = true := by
  have hnc' : ¬ hasKey keys key = true := fun hmem => hnc (hsound keys key hmem)
  simp only [insertSortedBy]
  rw [ite_eq_right hnc, ite_eq_left hs]
  exact insertSortedAux_sorted lt hconn key keys hs hnc'

def natLt (a b : Nat) : Bool := decide (a < b)

theorem natLt_conn (a b : Nat) : ¬ natLt a b = true → a = b ∨ natLt b a = true := by
  intro h
  simp only [natLt, decide_eq_true_eq] at h
  rcases Nat.lt_or_ge b a with hlt | hge
  · exact Or.inr (by simp [natLt, hlt])
  · exact Or.inl (Nat.le_antisymm hge (Nat.not_lt.mp h))

theorem insertSortedBy_nat_sorted (keys : List Nat) (key : Nat)
    (hnc : ¬ hasKey keys key = true) (hs : isSortedBy natLt keys = true) :
    isSortedBy natLt (insertSortedBy natLt hasKey keys key) = true :=
  insertSortedBy_sorted natLt hasKey (fun _ _ hmem => hmem) natLt_conn keys key hnc hs

def strLt (a b : String) : Bool := decide (a < b)

theorem strLt_conn (a b : String) (h : ¬ strLt a b = true) :
    a = b ∨ strLt b a = true := by
  rcases Std.lt_trichotomy a b with hlt | heq | hgt
  · exact absurd (by simp [strLt, hlt]) h
  · exact Or.inl heq
  · exact Or.inr (by simp [strLt, hgt])

def unitLtFrom : List Nat → List Nat → Bool
  | [], [] => false
  | [], _ :: _ => true
  | _ :: _, [] => false
  | x :: xs, y :: ys =>
      if x < y then true else if y < x then false else unitLtFrom xs ys

theorem unitLtFrom_conn (a b : List Nat) (h : ¬ unitLtFrom a b = true) :
    a = b ∨ unitLtFrom b a = true := by
  induction a generalizing b with
  | nil =>
      cases b with
      | nil => exact Or.inl rfl
      | cons y ys =>
          have hfalse : unitLtFrom [] (y :: ys) = true := rfl
          exact absurd hfalse h
  | cons x xs ih =>
      cases b with
      | nil => exact Or.inr (by simp [unitLtFrom])
      | cons y ys =>
          by_cases hxy : x < y
          · exact absurd (by simp [unitLtFrom, hxy]) h
          · by_cases hyx : y < x
            · exact Or.inr (by simp [unitLtFrom, hyx])
            · have htail : ¬ unitLtFrom xs ys = true := by
                simpa [unitLtFrom, hxy, hyx] using h
              rcases ih ys htail with heq | hlt
              · left
                have heqxy : x = y := by omega
                rw [heqxy, heq]
              · exact Or.inr (by simp [unitLtFrom, hxy, hyx, hlt])

theorem unitLtFrom_irrefl (a : List Nat) : unitLtFrom a a = false := by
  induction a with
  | nil => rfl
  | cons x xs ih => simp [unitLtFrom, Nat.lt_irrefl, ih]

theorem insertSortedBy_units_sorted (keys : List (List Nat)) (key : List Nat)
    (hnc : ¬ hasKey keys key = true) (hs : isSortedBy unitLtFrom keys = true) :
    isSortedBy unitLtFrom (insertSortedBy unitLtFrom hasKey keys key) = true :=
  insertSortedBy_sorted unitLtFrom hasKey (fun _ _ hmem => hmem) unitLtFrom_conn
    keys key hnc hs

/- The shipped `insertSorted` compares UTF-16 code units, which is lexicographic
   order on the unit sequence (an astral character becomes a surrogate pair).
   `utf16Units` maps a string to that sequence and `insertSortedBy_units_sorted`
   proves sortedness for exactly that order. Lean's own `String` `<` is UTF-8
   byte order, so it is deliberately not used as the production order here. -/
def utf16Units (s : String) : List Nat :=
  (s.toList.map fun c =>
    if c.toNat < 0x10000 then [c.toNat]
    else
      let n := c.toNat - 0x10000
      [0xD800 + n / 0x400, 0xDC00 + n % 0x400]).flatten
