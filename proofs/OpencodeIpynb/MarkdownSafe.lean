namespace OpencodeIpynb

def MAX_FENCE : Nat := 32

def clampChars (chars : List Char) (limit : Nat) : List Char :=
  if chars.length ≤ limit then chars else chars.take limit

def closingOf : Option (Char × Nat) → List Char
  | none => []
  | some (fenceChar, run) => ['\n'] ++ List.replicate run fenceChar ++ ['\n']

def truncateMarkdownWith (squash stripTrailing : List Char → List Char)
    (scanFence : List Char → Option (Char × Nat))
    (text : List Char) (maxChars : Nat) (hint : List Char) : List Char :=
  if text.length ≤ maxChars then text
  else
    let budget := max 0 (maxChars - hint.length - 2 * MAX_FENCE)
    let cut := squash (text.take budget)
    clampChars (stripTrailing cut ++ closingOf (scanFence cut) ++ hint) maxChars

theorem clampChars_le (chars : List Char) (limit : Nat) :
    (clampChars chars limit).length ≤ limit := by
  simp only [clampChars]
  by_cases h : chars.length ≤ limit
  · rw [ite_eq_left h]
    exact h
  · rw [ite_eq_right h]
    exact List.length_take_le limit chars

theorem truncateMarkdownWith_length_le (squash stripTrailing : List Char → List Char)
    (scanFence : List Char → Option (Char × Nat))
    (text : List Char) (maxChars : Nat) (hint : List Char) :
    (truncateMarkdownWith squash stripTrailing scanFence text maxChars hint).length ≤
      maxChars := by
  simp only [truncateMarkdownWith]
  by_cases h : text.length ≤ maxChars
  · rw [ite_eq_left h]
    exact h
  · rw [ite_eq_right h]
    exact clampChars_le _ maxChars

theorem truncateMarkdownWith_identity (squash stripTrailing : List Char → List Char)
    (scanFence : List Char → Option (Char × Nat))
    (text : List Char) (maxChars : Nat) (hint : List Char)
    (h : text.length ≤ maxChars) :
    truncateMarkdownWith squash stripTrailing scanFence text maxChars hint = text := by
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

theorem truncateMarkdownWith_hint_survives (squash stripTrailing : List Char → List Char)
    (scanFence : List Char → Option (Char × Nat))
    (hsquash : ∀ chars, (squash chars).length ≤ chars.length)
    (hstrip : ∀ chars, (stripTrailing chars).length ≤ chars.length)
    (hfence : ∀ chars fence, scanFence chars = some fence → fence.2 ≤ MAX_FENCE)
    (text : List Char) (hint : List Char) (maxChars : Nat)
    (hbig : maxChars < text.length)
    (hbudget : hint.length + 2 * MAX_FENCE ≤ maxChars) :
    ∃ pre,
      truncateMarkdownWith squash stripTrailing scanFence text maxChars hint =
        pre ++ hint := by
  simp only [truncateMarkdownWith]
  rw [ite_eq_right (by omega : ¬ (text.length ≤ maxChars))]
  rw [saneBudget maxChars hint.length hbudget]
  have hcut : (squash (text.take (maxChars - hint.length - 2 * MAX_FENCE))).length ≤
      maxChars - hint.length - 2 * MAX_FENCE :=
    Nat.le_trans (hsquash _) (List.length_take_le _ _)
  have hstripped :
      (stripTrailing (squash (text.take (maxChars - hint.length - 2 * MAX_FENCE)))).length ≤
        maxChars - hint.length - 2 * MAX_FENCE :=
    Nat.le_trans (hstrip _) hcut
  have hclosing :
      (closingOf (scanFence (squash (text.take (maxChars - hint.length - 2 * MAX_FENCE))))).length ≤
        2 + MAX_FENCE := by
    cases hscan :
      scanFence (squash (text.take (maxChars - hint.length - 2 * MAX_FENCE))) with
    | none =>
        simp [closingOf]
    | some fence =>
        obtain ⟨fenceChar, run⟩ := fence
        have hrun := hfence _ (fenceChar, run) hscan
        simp only [closingOf]
        simp
        omega
  refine ⟨
    stripTrailing (squash (text.take (maxChars - hint.length - 2 * MAX_FENCE))) ++
      closingOf (scanFence (squash (text.take (maxChars - hint.length - 2 * MAX_FENCE)))),
    ?_⟩
  have htotal :
      (stripTrailing (squash (text.take (maxChars - hint.length - 2 * MAX_FENCE))) ++
          closingOf (scanFence (squash (text.take (maxChars - hint.length - 2 * MAX_FENCE)))) ++
          hint).length ≤
        maxChars := by
    have hfenceVal : MAX_FENCE = 32 := rfl
    rw [List.length_append, List.length_append]
    omega
  rw [clampChars_within _ maxChars htotal]

end OpencodeIpynb
