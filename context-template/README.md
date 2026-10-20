# Context repo (template)

Seed for the organization's context repository (PRD FR-C1). Copy this directory into its
own repo. Every agent reads from it by path; agents propose changes only through pull
requests that a human reviews (FR-C4).

| Path | Holds | Owner field |
|---|---|---|
| `company/overview.md` | What the company does, customers, vocabulary that matters | yes |
| `projects/<name>/` | Spec and architecture per project | yes |
| `conventions/` | Coding, testing, and review conventions | yes |
| `playbooks/` | How-to procedures (release, incident, onboarding a repo) | yes |
| `roles/` | Canonical instructions per agent role, referenced by `instructions:` in agent definitions | yes |
| `decisions/` | One decision record per approved proposal, `D-NNNN-slug.md` | approver |
| `ownership.yaml` | Who owns which repos and paths, and how to contact them | n/a |
| `approvals.yaml` | Who may approve which proposals (FR-H2, used from M2) | n/a |
| `glossary.md` | Terms agents must use consistently | yes |

Every Markdown document starts with front matter naming an `owner` and a `reviewed` date,
so staleness can be reported (FR-C5, from M4).

Keep documents short. Agents load them on demand, and every extra line is paid for in
every run that reads it.
