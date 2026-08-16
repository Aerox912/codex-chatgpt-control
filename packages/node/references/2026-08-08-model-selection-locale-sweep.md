---
title: Model Selection Locale Sweep
date: 2026-08-08
type: review
status: complete
---

# Model Selection Locale Sweep

English plus all 64 non-English languages advertised in ChatGPT Settings were
captured from one authenticated live account against the current selector UI.

The latest record for every locale passed these gates:

- rendered `html lang` matched the requested language;
- Chat exposed Power plus ordered Model/Effort rows;
- Work exposed Power plus ordered Model/Effort/Speed rows;
- Chat contained 3 model and 5 effort options;
- Work contained 4 model, 6 effort, and 2 speed options;
- captured labels were non-empty;
- Chat and the initial rendered language were restored.

The append-only private-source evidence contains 77 attempts: 65 latest
successes and 12 earlier blocked attempts retained for diagnostics. Every
blocked locale was subsequently recaptured successfully. The reviewed apply
updated all 64 non-English locale contributions and was idempotent on a second
run.

This is point-in-time evidence for the account and rollout observed on
2026-08-08. It does not guarantee identical model inventory for every plan,
region, workspace, or experiment. Generation-state, project, and plugin labels
were outside this no-prompt sweep.
