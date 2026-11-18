namespace OpencodeIpynb

inductive SChar where
  | plain (c : Char)
  | lineBreak
  deriving DecidableEq, Repr

def SChar.isBreak : SChar → Bool
  | .lineBreak => true
  | .plain _ => false

def splitFrom (c : SChar) (acc : List (List SChar)) : List (List SChar) :=
  match acc with
  | [] => [[c]]
  | head :: tail => if c.isBreak then [c] :: head :: tail else (c :: head) :: tail

def splitLines (chars : List SChar) : List (List SChar) :=
  chars.foldr splitFrom []

theorem splitFrom_flatten (c : SChar) (acc : List (List SChar)) :
    (splitFrom c acc).flatten = c :: acc.flatten := by
  cases acc with
  | nil => simp [splitFrom]
  | cons head tail =>
    simp only [splitFrom]
    by_cases h : c.isBreak
    · simp [h]
    · simp [h]

theorem splitLines_flatten (chars : List SChar) :
    (splitLines chars).flatten = chars := by
  induction chars with
  | nil => simp [splitLines]
  | cons c rest ih =>
    have hfold : splitLines rest = List.foldr splitFrom [] rest := by
      simp [splitLines]
    rw [hfold] at ih
    simp only [splitLines, List.foldr_cons, splitFrom_flatten, ih]

theorem splitLines_empty : splitLines [] = ([] : List (List SChar)) := by
  simp [splitLines]

theorem splitLines_single_break :
    splitLines [SChar.lineBreak] = [[SChar.lineBreak]] := by
  simp [splitLines, splitFrom]

theorem splitLines_break_then_plain :
    splitLines [SChar.lineBreak, SChar.plain 'a'] =
      [[SChar.lineBreak], [SChar.plain 'a']] := by
  simp [splitLines, splitFrom, SChar.isBreak]

end OpencodeIpynb
