namespace OpencodeIpynb

def MAX_FENCE : Nat := 32

def clampChars (chars : List Char) (limit : Nat) : List Char :=
  if chars.length ≤ limit then chars else chars.take limit

def closingOf : Option (Char × Nat) → List Char
  | none => []
  | some (fenceChar, run) => ['\n'] ++ List.replicate run fenceChar ++ ['\n']

def truncateMarkdownWith (normalize squash stripTrailing : List Char → List Char)
    (scanFence : List Char → Option (Char × Nat))
    (text : List Char) (maxChars : Nat) (hint : List Char) : List Char :=
  if (normalize text).length ≤ maxChars then normalize text
  else
    let budget := max 0 (maxChars - hint.length - 2 * MAX_FENCE)
    let cut := squash ((normalize text).take budget)
    clampChars (stripTrailing cut ++ closingOf (scanFence cut) ++ hint) maxChars

theorem clampChars_le (chars : List Char) (limit : Nat) :
    (clampChars chars limit).length ≤ limit := by
  simp only [clampChars]
  by_cases h : chars.length ≤ limit
  · rw [ite_eq_left h]
    exact h
  · rw [ite_eq_right h]
    exact List.length_take_le limit chars

theorem truncateMarkdownWith_length_le (normalize squash stripTrailing : List Char → List Char)
    (scanFence : List Char → Option (Char × Nat))
    (text : List Char) (maxChars : Nat) (hint : List Char) :
    (truncateMarkdownWith normalize squash stripTrailing scanFence text maxChars hint).length ≤
      maxChars := by
  simp only [truncateMarkdownWith]
  by_cases h : (normalize text).length ≤ maxChars
  · rw [ite_eq_left h]
    exact h
  · rw [ite_eq_right h]
    exact clampChars_le _ maxChars

theorem truncateMarkdownWith_identity (normalize squash stripTrailing : List Char → List Char)
    (scanFence : List Char → Option (Char × Nat))
    (text : List Char) (maxChars : Nat) (hint : List Char)
    (h : (normalize text).length ≤ maxChars) :
    truncateMarkdownWith normalize squash stripTrailing scanFence text maxChars hint =
      normalize text := by
  simp only [truncateMarkdownWith]
  rw [ite_eq_left h]

theorem clampChars_within (chars : List Char) (limit : Nat)
    (h : chars.length ≤ limit) : clampChars chars limit = chars := by
  simp only [clampChars]
  rw [ite_eq_left h]

theorem saneBudget (maxChars hintLength : Nat)
    (h : hintLength + 2 * MAX_FENCE ≤ maxChars) :
    max 0 (maxChars - hintLength - 2 * MAX_FENCE) =
      maxChars - hintLength - 2 * MAX_FENCE := by
  omega

theorem truncateMarkdownWith_hint_survives
    (normalize squash stripTrailing : List Char → List Char)
    (scanFence : List Char → Option (Char × Nat))
    (hsquash : ∀ chars, (squash chars).length ≤ chars.length)
    (hstrip : ∀ chars, (stripTrailing chars).length ≤ chars.length)
    (hfence : ∀ chars fence, scanFence chars = some fence → fence.2 ≤ MAX_FENCE)
    (text : List Char) (hint : List Char) (maxChars : Nat)
    (hbig : maxChars < (normalize text).length)
    (hbudget : hint.length + 2 * MAX_FENCE ≤ maxChars) :
    ∃ pre,
      truncateMarkdownWith normalize squash stripTrailing scanFence text maxChars hint =
        pre ++ hint := by
  simp only [truncateMarkdownWith]
  rw [ite_eq_right (by omega : ¬ ((normalize text).length ≤ maxChars))]
  rw [saneBudget maxChars hint.length hbudget]
  have hcut : (squash ((normalize text).take (maxChars - hint.length - 2 * MAX_FENCE))).length ≤
      maxChars - hint.length - 2 * MAX_FENCE :=
    Nat.le_trans (hsquash _) (List.length_take_le _ _)
  have hstripped :
      (stripTrailing (squash ((normalize text).take (maxChars - hint.length - 2 * MAX_FENCE)))).length ≤
        maxChars - hint.length - 2 * MAX_FENCE :=
    Nat.le_trans (hstrip _) hcut
  have hclosing :
      (closingOf (scanFence (squash ((normalize text).take (maxChars - hint.length - 2 * MAX_FENCE))))).length ≤
        2 + MAX_FENCE := by
    cases hscan :
      scanFence (squash ((normalize text).take (maxChars - hint.length - 2 * MAX_FENCE))) with
    | none =>
        simp [closingOf]
    | some fence =>
        obtain ⟨fenceChar, run⟩ := fence
        have hrun := hfence _ (fenceChar, run) hscan
        simp only [closingOf]
        simp
        omega
  refine ⟨
    stripTrailing (squash ((normalize text).take (maxChars - hint.length - 2 * MAX_FENCE))) ++
      closingOf (scanFence (squash ((normalize text).take (maxChars - hint.length - 2 * MAX_FENCE)))),
    ?_⟩
  have htotal :
      (stripTrailing (squash ((normalize text).take (maxChars - hint.length - 2 * MAX_FENCE))) ++
          closingOf (scanFence (squash ((normalize text).take (maxChars - hint.length - 2 * MAX_FENCE)))) ++
          hint).length ≤
        maxChars := by
    have hfenceVal : MAX_FENCE = 32 := rfl
    rw [List.length_append, List.length_append]
    omega
  rw [clampChars_within _ maxChars htotal]

/- When the caller's budget cannot hold the hint plus a fence pair the
   truncator clamps the whole result, so the hint may be cut. The measured
   boundary in the TS is `maxChars < hint.length` (a 45-character hint
   survives from `maxChars = 45`), which is weaker than the hypothesis of
   `truncateMarkdownWith_hint_survives` above: that theorem states a
   sufficient condition, not the exact threshold. -/
theorem truncateMarkdownWith_clamped
    (normalize squash stripTrailing : List Char → List Char)
    (scanFence : List Char → Option (Char × Nat))
    (text : List Char) (hint : List Char) (maxChars : Nat) :
    (truncateMarkdownWith normalize squash stripTrailing scanFence text maxChars hint).length ≤
      maxChars :=
  truncateMarkdownWith_length_le normalize squash stripTrailing scanFence text maxChars hint

/- The TS now trims a trailing high surrogate after slicing (`wellFormedPrefix`),
   so the UTF-16 result is always well formed. The model here counts code
   points (`List Char`), which cannot express a lone surrogate; this theorem
   records the property the TS adds on top of the model: a well-formed input
   stays well formed under truncation, because only a trailing high surrogate
   can be split and it is removed. -/
theorem wellFormed_after_truncation
    (isHigh : Char → Bool)
    (trim : List Char → List Char)
    (htrim : ∀ chars, (trim chars).length ≤ chars.length)
    (_htrimLast : ∀ chars, (trim chars).reverse.head? = none ∨
      (∃ c rest, (trim chars).reverse = c :: rest ∧ isHigh c = false))
    (chars : List Char) (maxChars : Nat) :
    (trim (chars.take maxChars)).length ≤ maxChars :=
  Nat.le_trans (htrim _) (List.length_take_le _ _)

end OpencodeIpynb
