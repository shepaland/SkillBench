# Smoke prompt steps (reference copy)

This mirrors `promptSteps` in `smoke/case.json` for humans reading the smoke check
without parsing JSON. The case manifest is the source of truth.

1. `s1` — "Read app.js. In one sentence, describe how you would change greet so that
   greet(\"ann\") returns \"hello ann\". Do not edit any file yet; wait for my
   go-ahead." Gated by the `stopped_first` transcript rule (`no_file_change`): the
   run only proceeds to step 2 once the transcript shows no file was touched during
   step 1.
2. `s2` — "Go ahead and make that change now."
