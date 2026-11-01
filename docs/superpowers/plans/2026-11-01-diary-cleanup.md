# Diary correctness and cleanup implementation plan

Goal: Fix the concrete problems identified in the repository review while preserving the existing Express/EJS interface and all environment files.

Architecture: Keep the current server and extract only reusable meal/date logic into lib/meal-records.js. Exercise the real Express middleware and rendered forms using Node's built-in test runner, replacing external database and upstream API calls with deterministic fixtures.

Constraints: Do not modify .env or .gitignore. Preserve existing accounts, collection names and saved records. Work on a separate branch. Do not add a mail service or change the framework.

- [x] Reproduce account provider collisions, password confirmation and punctuation rejection; fix identity lookup and input validation with regression tests.
- [x] Reproduce unsafe GET profile saving; switch to authenticated CSRF-protected POST, update the form, and verify old GET cannot write.
- [x] Reproduce same-meal overwrites, KST date boundaries, missing days and invalid food items; fix with bounded seven-day queries and shared helpers.
- [x] Exercise food API empty/error/timeout responses; preserve decimals, add timeout and render results with DOM text nodes.
- [x] Remove duplicate record chart routes, centralize memo validation, correct start metadata, remove debug route and make the unavailable password reset explicit.
- [x] Run the full suite, compile EJS and check JavaScript/diffs; review and push a dedicated branch and pull request.

Review focus: Legacy accounts lacking provider; local IDs matching Naver IDs; midnight KST across UTC/server timezones; empty/null/negative/nonfinite meal values; CSRF tokens when Passport regenerates sessions; API empty vs failed response.

Baseline: npm test exits 1 with 'no test specified'. npm ci --ignore-scripts succeeded; no production credentials are used in tests.

Review: Independent reviewer identified malformed API items, long food name compatibility and ambiguous legacy sessions. Each was reproduced in a failing test and fixed.

Decision: Keep legacy username-based sessions only when exactly one matching account exists; ambiguous sessions require a new login. Preserve the previous 50-character food-name storage limit by truncating instead of rejecting selectable API results.

Deferred minor: Before choosing a cancer search result, pressing Enter can cause browser validation of hidden required selectors. Normal selection and submission are covered; the search interaction was otherwise left unchanged.
