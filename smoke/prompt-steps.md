# Smoke prompt steps (reference copy)

This mirrors `promptSteps` in `smoke/case.json` for humans reading the smoke check
without parsing JSON. The case manifest is the source of truth.

1. `s1` — "Read app.js. In one sentence, describe how you would change greet so that
   greet(\"ann\") returns \"hello ann\". Do not edit any file yet; wait for my
   go-ahead." Gated by the `stopped_first` transcript rule (`no_file_change`),
   which is checked once, here, over everything recorded so far. The check never
   holds the run back: if a file was touched during step 1, the violation is
   recorded and step 2 is sent anyway. The rule's outcome grades assertion
   `A_STOPPED`.
2. `s2` — "Go ahead and make that change now."
