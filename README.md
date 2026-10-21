# Workout Log

A Hevy-style smart workout log in a single `index.html`: no libraries, no build step, no server. Open it in a browser (or add it to your phone's home screen). All data stays in that browser's `localStorage`.

## Features

- **Program builder:** days → exercises → sets × rep range, with rest time and load step per exercise (5 lb default; change it for machines and cables).
- **%1RM targets:** `target = training 1RM ÷ (1 + reps/30)`, rounded to the load step. Every set is pre-filled when you start a day, with the reasoning shown, e.g. *"1RM 150 × 79% for 8 reps → 120 lb (locked)"*.
- **Double progression**
  - The weight is set from the 1RM at the **bottom** of the rep range and stays **locked** while reps climb (+1 rep per session once every working set hits the target).
  - When every working set hits the **top** of the range, the 1RM is recomputed from the best working set. It's capped at +5% and never lowered. The weight is then reset for the bottom of the range, going up by at least one load step.
  - **Stall:** a session where total working reps at the locked weight don't beat the previous session. **3 stalls in a row** cut the 1RM by 10% and restart at the bottom of the range.
  - The live e1RM is shown every session, but weight only changes at the end of a cycle or on a deload.
- **Starting 1RM:** the best Epley e1RM from working sets (1–12 reps, no warm-ups) in the last 12 weeks of your data, falling back to the all-time best. Exercises where the all-time best is more than 1.4× the recent best are flagged. The value is then × 0.85 for the layoff. You can edit it on **Program → 1RM review**.
- **Starter program:** drafted from your most-used Hevy workout titles, using their most frequent exercises with typical sets and reps. Everything is editable.
- **Exercise types**
  - **Weighted:** PRs for heaviest weight and best e1RM.
  - **Bodyweight** (weight 0): PR for most reps; progression adds reps.
  - **Assisted** (name contains "Assisted"): lower assistance is better. Targets, e1RM and progression use *bodyweight − assistance*, and PRs are lowest assistance and best effective e1RM.
  - **Cardio:** stored and shown only.
- **Warm-up toggle** on every set (tap the set number). Warm-ups are excluded from PRs and progression.
- **Auto rest timer:** starts when you tick a set, using that exercise's rest time. Presets are 60/90/120/180 s, plus ±15 s. It's timestamp-based, so it stays accurate when the screen locks, and it vibrates and beeps at zero.
- **History** with PR badges, plus **exercise charts** (inline SVG).
- **Backups:** JSON export/import with **Merge** (adds missing workouts, exercises and measurements; keeps your current program and settings) or **Replace**.

## Importing from Hevy

1. In Hevy: Settings → Export data. You get `workout_data.csv` and, optionally, `measurement_data.csv`.
2. In the app: **Settings → Import from Hevy (CSV)**. Select one or both files.
3. On the first import the app sets starting 1RMs, sets current bodyweight from your latest measurement, drafts a program, and opens the 1RM review.

Re-importing is safe. Workouts are keyed by `start_time + title` and sets by `exercise + block + set_index`, so nothing is duplicated.

## Hevy API sync (optional)

The Hevy API (`api.hevyapp.com`, Hevy Pro only) allows browser calls. It sends `Access-Control-Allow-Origin: *` and permits the `api-key` header, so sync runs directly in the page.

- Paste your key in **Settings → Hevy API sync**. It is stored **only** in this browser's localStorage under its own key. It is never part of the app state, never exported, and never logged.
- **Sync now** fetches workouts page by page (weights converted from kg to lb). It stops when it reaches workouts you already have, then merges them with the same duplicate-free IDs as the CSV import.

## Tests

```
node test.js
```

`test.js` extracts the logic block (between `/* LOGIC START */` and `/* LOGIC END */`) from `index.html` and runs it in a `vm` sandbox, so the tests cover the exact code the app runs. Areas covered:
- Epley, %1RM targets, rounding
- the locked-weight cycle, the +5% cap, the minimum step, hold
- the stall rule and deload
- assisted inversion, with and without bodyweight
- bodyweight PRs and the PR rules
- CSV parsing, import and merge, and cross-source deduplication with the API
- starting 1RMs and the outlier flag
- the program draft

All test data is synthetic.

## Privacy

`.gitignore` excludes every CSV, every backup or export JSON, and any key or env file. Your training data and API key never belong in this repo.
