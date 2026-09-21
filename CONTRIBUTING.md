# Contributing to Walfly

## Workflow & Issue Tracking

Walfly uses **GitHub Projects & GitHub Issues** as the central coordination system for both humans and AI agents.

### 1. Board & Tasks
- **Kanban Board**: [GitHub Project #3 (`walfly`)](https://github.com/users/SonicDMG/projects/3)
- Check open issues via web UI or GitHub CLI:
  ```bash
  gh issue list --repo SonicDMG/walfly --state open
  ```
- Claim an issue before starting work:
  ```bash
  gh issue edit <ISSUE_NUM> --add-assignee "@me"
  ```

### 2. Development Workflow (Worktrees or Branches)
- Branch from `origin/main` using the issue number:
  ```bash
  git checkout -b feat/<ISSUE_NUM>-<description>
  ```
- Or use an isolated worktree (recommended for multi-task or agent setups):
  ```bash
  git worktree add -b feat/<ISSUE_NUM>-<description> .worktrees/<ISSUE_NUM> origin/main
  cd .worktrees/<ISSUE_NUM>
  ```

### 3. Pull Requests
- Open a draft PR once work begins, referencing the issue:
  ```bash
  gh pr create --draft --title "[GH-<ISSUE_NUM>] <Title>" --body "Fixes #<ISSUE_NUM>"
  ```
- When the PR merges into `main`, GitHub automatically closes Issue `#<ISSUE_NUM>` and transitions the card to **Done** on the project board.
