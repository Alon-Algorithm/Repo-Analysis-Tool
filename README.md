# Repo Analysis Tool (RAT)

A web-app dashboard that analyses Git repositories and computes **file**, **directory**,
**repository**, **commit-set** and **author** metrics.

Built for the COMS3011A test: *"Git repositories tend to be very opaque to understanding.
Git does not make it easy to understand how a repo has evolved, who has had the most impact
where, and what parts of the project are the most volatile."* — RAT fixes that.

## Features

- **Repository ingestion — two forms**
  - ZIP file of a repository that contains its `.git` file or directory (drag & drop upload)
  - Remote repository URL, cloned deeply (full history, no shallow clones)
- **Multiple repository support** — analyse and compare several repos side by side
- **Filters** — by repository, author, file or directory, and commit set:
  - a specified period of time, or
  - a manually selected list of commits
- **Author merging** — automatic via `.mailmap`, and manual merging of identities
  when no mailmap is provided
- **Metric categories** — File, Directory, Repository (root), Commit-set and Author metrics
  (added lines, removed lines, growth, churn, modifications, modification frequency,
  churn rate, author ownership)

## Requirements

- [Node.js](https://nodejs.org/) **>= 18** (uses only the Node standard library — there are
  **no npm dependencies to install**; the charting library is vendored in `web/vendor/`)
- `git` on the `PATH`
- `unzip` on the `PATH` (only needed for ZIP uploads)
- Network access (only if you ingest repositories by URL)

## Run it

```bash
npm run dev
```

Then open <http://localhost:3000> in your browser.

No `npm install` step is required — the project has zero runtime dependencies.
(`npm install` is harmless and does nothing.)

### First steps in the UI

1. Click **Add repository** and either paste a clone URL (e.g.
   `https://github.com/DaveGamble/cJSON.git`) or drop in a ZIP of a repo that
   contains its `.git` directory.
2. Wait for the import pipeline to finish (progress is shown live). The huge repos
   are cached after the first import, so subsequent visits are instant.
3. Explore the dashboard: overview KPIs, churn timeline, directory treemap,
   file drill-down, author leaderboard and ownership heatmap.
4. Use the timeline brush (or the commit list picker) to choose a commit set, then
   watch every metric and chart recompute for that set.
5. Merge author identities under **Authors → Merge** (pre-seeded from `.mailmap`
   when the repo has one).

## Other scripts

```bash
npm test          # unit tests (parser + metric engine fixtures)
npm run validate  # validate metric correctness against samples/ reference CSVs
```

## Architecture

```
ZIP upload / git clone (bare, full history)
        │
        ▼
Single `git log` pass      git log --no-merges --use-mailmap -M50% --numstat -z
        │                  (rename detection at 50%, binary files reported as "-")
        ▼
Streaming numstat parser   O(bytes) memory, no intermediate files
        │
        ▼
Index (JSON per repo)      commits · changes · authors · paths · directories
        │
        ▼
Metric engine              per-commit deltas → subtree roll-ups → commit-set aggregation
        │                  (every filter = one linear scan over precomputed deltas)
        ▼
HTTP API + dashboard       filters (repo/author/path/commit-set) recompute in ~ms
```

Key design decisions:

- **One extraction pass per repo.** All metrics for every commit set are derived from a
  single indexed set of per-commit, per-file deltas; filters never re-run `git`.
- **Spec-exact semantics.** Non-merge commits only; rename detection at 50%; changes
  from rename+edit are attributed to the new path; deletion lines are recorded on the
  deleted path; binary files are listed but not measured.
- **Author identities stay raw in the index.** `.mailmap` mapping and manual merging are
  applied at query time, so merging authors never requires re-importing a repository.

## Metrics (summary)

Per commit `h` and object `o` (file or directory):

| Metric | Meaning |
| --- | --- |
| Added lines `l+` | lines added in `o` vs the previous commit |
| Removed lines `l-` | lines removed in `o` vs the previous commit |
| Growth `δ` | `l+ − l-` |
| Churn `λ` | `l+ + l-` |
| Modifications `n` | number of commits in the set with `λ > 0` on `o` |
| Modification frequency `η` | `n / |H|` |
| Churn rate `ρ` | `λ / |H|` |
| Author churn `λ_a` | churn on `o` from author `a` |
| Author ownership `ω` | `λ_a / λ` |

Directory metrics aggregate their whole subtree; the repository is the root directory.
Commit-set metrics are summed/detected over the selected set `H` with
`H_i,j = { h : i ≤ committer-date(h) < j }`.

## AI Declaration

*(To be completed before submission — list any AI tools used and how.)*

## License

MIT
