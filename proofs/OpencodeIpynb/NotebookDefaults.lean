import OpencodeIpynb.InsertSorted

namespace OpencodeIpynb

abbrev Entry := String × Nat

def lookupEntry : List Entry → String → Nat
  | [], _ => 0
  | (k, v) :: rest, key => if (k == key) then v else lookupEntry rest key

def hasEntryKey : List Entry → String → Bool
  | [], _ => false
  | (k, _) :: rest, key => if (k == key) then true else hasEntryKey rest key

def entryKeyLt (a b : Entry) : Bool := decide (a.1 < b.1)

def applyDefault (entries : List Entry) (key : String) (value : Nat) : List Entry :=
  if hasEntryKey entries key then entries
  else
    insertSortedBy entryKeyLt (fun es e => hasEntryKey es e.1) entries (key, value)

theorem applyDefault_present_noop (entries : List Entry) (key : String) (value : Nat)
    (hmem : hasEntryKey entries key = true) :
    applyDefault entries key value = entries := by
  simp only [applyDefault]
  rw [ite_eq_left hmem]

theorem hasEntryKey_mid (k₀ : String) (v₀ : Nat) (post : List Entry) :
    ∀ pre : List Entry,
      hasEntryKey (pre ++ (k₀, v₀) :: post) k₀ = true := by
  intro pre
  induction pre with
  | nil =>
    simp only [List.nil_append, hasEntryKey]
    rw [ite_eq_left (beq_self_eq_true k₀)]
  | cons head rest ih =>
    obtain ⟨p, v⟩ := head
    simp only [List.cons_append, hasEntryKey]
    by_cases hp : (p == k₀) = true
    · rw [ite_eq_left hp]
    · rw [ite_eq_right hp]
      exact ih

theorem hasEntryKey_append_left (k : String) (post : List Entry) :
    ∀ pre : List Entry,
      hasEntryKey pre k = true → hasEntryKey (pre ++ post) k = true := by
  intro pre
  induction pre with
  | nil => intro h; exact Bool.noConfusion h
  | cons head rest ih =>
    obtain ⟨p, v⟩ := head
    intro h
    simp only [List.cons_append, hasEntryKey] at h ⊢
    by_cases hp : (p == k) = true
    · rw [ite_eq_left hp]
    · rw [ite_eq_right hp] at h
      rw [ite_eq_right hp]
      exact ih h

theorem lookupEntry_mid_ne (k₀ : String) (v₀ : Nat) (post : List Entry) (k : String)
    (hne : ¬ (k₀ == k) = true) :
    ∀ pre : List Entry,
      lookupEntry (pre ++ (k₀, v₀) :: post) k = lookupEntry (pre ++ post) k := by
  intro pre
  induction pre with
  | nil =>
    simp only [List.nil_append]
    simp only [lookupEntry]
    rw [ite_eq_right hne]
  | cons head rest ih =>
    obtain ⟨p, v⟩ := head
    simp only [List.cons_append, lookupEntry]
    by_cases hp : (p == k) = true
    · rw [ite_eq_left hp, ite_eq_left hp]
    · rw [ite_eq_right hp, ite_eq_right hp]
      exact ih

theorem lookupEntry_hits (k₀ : String) (v₀ : Nat) (post : List Entry) :
    ∀ pre : List Entry,
      ¬ hasEntryKey pre k₀ = true →
      lookupEntry (pre ++ (k₀, v₀) :: post) k₀ = v₀ := by
  intro pre
  induction pre with
  | nil =>
    intro _
    simp only [List.nil_append, lookupEntry]
    rw [ite_eq_left (beq_self_eq_true k₀)]
  | cons head rest ih =>
    obtain ⟨p, v⟩ := head
    intro hclean
    simp only [hasEntryKey] at hclean
    simp only [List.cons_append, lookupEntry]
    by_cases hp : (p == k₀) = true
    · rw [ite_eq_left hp] at hclean
      exact absurd rfl hclean
    · rw [ite_eq_right hp] at hclean
      rw [ite_eq_right hp]
      exact ih hclean

theorem applyDefault_keeps_values (entries : List Entry) (key : String) (value : Nat)
    (k : String) (hne : ¬ (key == k) = true) :
    lookupEntry (applyDefault entries key value) k = lookupEntry entries k := by
  simp only [applyDefault]
  by_cases hmem : hasEntryKey entries key = true
  · rw [ite_eq_left hmem]
  · rw [ite_eq_right hmem]
    obtain ⟨pre, post, hres, horig⟩ :=
      insertSortedBy_positions entryKeyLt (fun es e => hasEntryKey es e.1) entries (key, value) hmem
    rw [hres, horig]
    simp only [List.append_assoc, List.cons_append, List.nil_append]
    exact lookupEntry_mid_ne key value post k hne pre

theorem applyDefault_sets_absent (entries : List Entry) (key : String) (value : Nat)
    (habs : ¬ hasEntryKey entries key = true) :
    lookupEntry (applyDefault entries key value) key = value := by
  simp only [applyDefault, ite_eq_right habs]
  obtain ⟨pre, post, hres, horig⟩ :=
    insertSortedBy_positions entryKeyLt (fun es e => hasEntryKey es e.1) entries (key, value) habs
  rw [hres]
  simp only [List.append_assoc, List.cons_append, List.nil_append]
  refine lookupEntry_hits key value post pre ?_
  intro hpre
  apply habs
  rw [horig]
  exact hasEntryKey_append_left key post pre hpre

theorem applyDefault_idempotent (entries : List Entry) (key : String) (value : Nat) :
    applyDefault (applyDefault entries key value) key value = applyDefault entries key value := by
  have houter : ∀ arg : List Entry, applyDefault arg key value =
      if hasEntryKey arg key = true then arg
      else insertSortedBy entryKeyLt (fun es e => hasEntryKey es e.1) arg (key, value) :=
    fun _ => rfl
  rw [houter, houter]
  by_cases hmem : hasEntryKey entries key = true
  · rw [ite_eq_left hmem, ite_eq_left hmem]
  · obtain ⟨pre, post, hres, horig⟩ :=
      insertSortedBy_positions entryKeyLt (fun es e => hasEntryKey es e.1) entries (key, value) hmem
    have hmid :
        hasEntryKey (insertSortedBy entryKeyLt (fun es e => hasEntryKey es e.1) entries (key, value)) key = true := by
      rw [hres]
      simp only [List.append_assoc, List.cons_append, List.nil_append]
      exact hasEntryKey_mid key value post pre
    rw [ite_eq_right hmem, ite_eq_left hmid]

end OpencodeIpynb
