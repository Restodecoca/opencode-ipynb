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

def applyDefaults (entries : List Entry) (defaults : List Entry) : List Entry :=
  match defaults with
  | [] => entries
  | (key, value) :: rest => applyDefaults (applyDefault entries key value) rest

theorem hasEntryKey_of_mem (defaults : List Entry) (d : Entry) (h : d ∈ defaults) :
    hasEntryKey defaults d.1 = true := by
  induction defaults with
  | nil => simp at h
  | cons head rest ih =>
    obtain ⟨hk, hv⟩ := head
    simp only [List.mem_cons] at h
    rcases h with heq | htail
    · subst heq
      simp only [hasEntryKey]
      rw [ite_eq_left (beq_self_eq_true hk)]
    · simp only [hasEntryKey]
      by_cases hd : (hk == d.1) = true
      · rw [ite_eq_left hd]
      · rw [ite_eq_right hd]
        exact ih htail

theorem hasEntryKey_applyDefault_self (entries : List Entry) (key : String) (value : Nat) :
    hasEntryKey (applyDefault entries key value) key = true := by
  simp only [applyDefault]
  by_cases hmem : hasEntryKey entries key = true
  · rw [ite_eq_left hmem]
    exact hmem
  · rw [ite_eq_right hmem]
    obtain ⟨pre, post, hres, _⟩ :=
      insertSortedBy_positions entryKeyLt (fun es e => hasEntryKey es e.1) entries (key, value) hmem
    rw [hres]
    simp only [List.append_assoc, List.cons_append, List.nil_append]
    exact hasEntryKey_mid key value post pre

theorem hasEntryKey_insert_mid (dk : String) (dv : Nat) (post : List Entry) (k : String) :
    ∀ pre : List Entry,
      hasEntryKey (pre ++ post) k = true →
      hasEntryKey (pre ++ (dk, dv) :: post) k = true := by
  intro pre
  induction pre with
  | nil =>
    intro h
    simp only [List.nil_append] at h ⊢
    simp only [hasEntryKey] at h ⊢
    by_cases hd : (dk == k) = true
    · rw [ite_eq_left hd]
    · rw [ite_eq_right hd]
      exact h
  | cons head rest ih =>
    intro h
    obtain ⟨hk, hv⟩ := head
    simp only [List.cons_append, hasEntryKey] at h ⊢
    by_cases hh : (hk == k) = true
    · rw [ite_eq_left hh]
    · rw [ite_eq_right hh] at h ⊢
      exact ih h

theorem hasEntryKey_applyDefault_preserve (entries : List Entry) (key' : String)
    (value' : Nat) (key : String) (h : hasEntryKey entries key = true) :
    hasEntryKey (applyDefault entries key' value') key = true := by
  simp only [applyDefault]
  by_cases hmem : hasEntryKey entries key' = true
  · rw [ite_eq_left hmem]
    exact h
  · rw [ite_eq_right hmem]
    obtain ⟨pre, post, hres, horig⟩ :=
      insertSortedBy_positions entryKeyLt (fun es e => hasEntryKey es e.1) entries (key', value') hmem
    rw [hres]
    rw [horig] at h
    simpa only [List.append_assoc, List.cons_append, List.nil_append] using
      hasEntryKey_insert_mid key' value' post key pre h

theorem hasEntryKey_applyDefaults_preserve (entries : List Entry) (defaults : List Entry)
    (key : String) (h : hasEntryKey entries key = true) :
    hasEntryKey (applyDefaults entries defaults) key = true := by
  induction defaults generalizing entries with
  | nil => exact h
  | cons d rest ih =>
    obtain ⟨dk, dv⟩ := d
    simp only [applyDefaults]
    exact ih (applyDefault entries dk dv)
      (hasEntryKey_applyDefault_preserve entries dk dv key h)

theorem hasEntryKey_applyDefaults_of_hasKey (entries : List Entry) (defaults : List Entry)
    (key : String) (h : hasEntryKey defaults key = true) :
    hasEntryKey (applyDefaults entries defaults) key = true := by
  induction defaults generalizing entries with
  | nil =>
    simp only [hasEntryKey] at h
    exact Bool.noConfusion h
  | cons d rest ih =>
    obtain ⟨dk, dv⟩ := d
    simp only [hasEntryKey] at h
    by_cases hd : (dk == key) = true
    · have hdk : dk = key := LawfulBEq.eq_of_beq hd
      rw [hdk]
      exact hasEntryKey_applyDefaults_preserve (applyDefault entries key dv) rest key
        (hasEntryKey_applyDefault_self entries key dv)
    · rw [ite_eq_right hd] at h
      exact ih (applyDefault entries dk dv) h

theorem applyDefaults_noop_of_present (entries : List Entry) (defaults : List Entry)
    (h : ∀ d ∈ defaults, hasEntryKey entries d.1 = true) :
    applyDefaults entries defaults = entries := by
  induction defaults generalizing entries with
  | nil => rfl
  | cons d rest ih =>
    obtain ⟨dk, dv⟩ := d
    simp only [applyDefaults]
    rw [applyDefault_present_noop entries dk dv (h (dk, dv) (by simp))]
    exact ih entries (fun e he => h e (by simp [he]))

theorem applyDefaults_idempotent (entries : List Entry) (defaults : List Entry) :
    applyDefaults (applyDefaults entries defaults) defaults =
      applyDefaults entries defaults := by
  apply applyDefaults_noop_of_present
  intro d hd
  exact hasEntryKey_applyDefaults_of_hasKey entries defaults d.1
    (hasEntryKey_of_mem defaults d hd)

end OpencodeIpynb
