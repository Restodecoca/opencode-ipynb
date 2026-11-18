import OpencodeIpynb.SourceLines

namespace OpencodeIpynb

inductive Shape where
  | string
  | array
  deriving DecidableEq, Repr

def renderSource : Shape → List SChar → List (List SChar)
  | .string, next => [next]
  | .array, next => splitLines next

theorem renderSource_flatten (shape : Shape) (next : List SChar) :
    (renderSource shape next).flatten = next := by
  cases shape with
  | string => simp [renderSource]
  | array => simp [renderSource, splitLines_flatten]

theorem renderSource_string_unsplit (next : List SChar) :
    renderSource .string next = [next] := rfl

def renderEach (shapeOf : List SChar → Shape) (texts : List (List SChar)) :
    List (List (List SChar)) :=
  texts.map (fun text => renderSource (shapeOf text) text)

theorem renderEach_join (shapeOf : List SChar → Shape) (texts : List (List SChar)) :
    (renderEach shapeOf texts).flatten.flatten = texts.flatten := by
  induction texts with
  | nil => simp [renderEach]
  | cons text rest ih =>
    have ih' :
        ((List.map (fun t => renderSource (shapeOf t) t) rest).flatten).flatten = rest.flatten := ih
    simp only [renderEach, List.map_cons, List.flatten_cons, List.flatten_append]
    rw [renderSource_flatten, ih']

end OpencodeIpynb
