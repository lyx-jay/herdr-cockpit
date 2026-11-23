# herdr-cockpit

A personal [Herdr](https://herdr.dev) layout for running many git worktrees at
once: one control-tower conversation, a floating panel that lists every checkout
of the repo you are in, and batch merge / cleanup built in.

```
┌──────────────┬──────────────────────────────────┬───────────────────┐
│ Spaces       │  the space you are in            │ WORKTREES  n      │
│ Agents       │  (control-tower opencode, …)     │ All Running Dirty │
│              │                                  │ Merged  To merge  │
└──────────────┴──────────────────────────────────┴───────────────────┘
                 ↑ cmd-shift-l switches to/from the shipped `main` layout
```

The panel floats over the terminal area (it can be dragged anywhere, Herdr
remembers where) and never reflows the terminal.

## Install

```bash
./install.sh          # links into ~/.config/herdr-app and binds cmd-alt-w
```

The app only reads `~/.config/herdr-app` (or `HERDR_APP_HOME`), so the files
here are linked in, not copied:

| Linked | To |
|---|---|
| `layouts/cockpit.json`, `layouts/cockpit.svg` | the app home |
| `mods/tabs-cockpit`, `mods/worktrees`, `mods/worktrees-menu`, `mods/worktrees-merge` | the app home |

`keys.json` is the person's whole keymap, so `install.sh` merges one binding into
it instead of linking: `cmd-alt-w` → `worktrees.toggle`.

Nothing shipped by Herdr is edited: `mods/tabs` and `layouts/main.json` stay
untouched, and `installed.json` keeps matching them.

## Files

| Path | What |
|---|---|
| `layouts/cockpit.json` | clone of the shipped `main`: `tabs` → `tabs-cockpit`, `worktrees-float` on `work-body` |
| `layouts/cockpit.svg` | preview shown in Settings |
| `mods/tabs-cockpit/` | clone of `mods/tabs` with one extra button (Worktrees toggle) |
| `mods/worktrees/` | the floating panel: data, filters, rows, docked-dialog sweep |
| `mods/worktrees-menu/` | right-click menu, Remove confirmation, Clean batch |
| `mods/worktrees-merge/` | To merge dialog: pre-flight, integration branch, merges, push |

## The panel

Toggle it with the top-bar `Worktrees` button, `cmd-alt-w`, or its `✕`. The
state lives in `shared("worktrees.open")`; closed means "render nothing", which
shrinks the floating block to 0×0.

Filters: `All`, `Running` (agent working/blocked), `Dirty` (uncommitted),
`Merged` (tip in `origin/master` **and** clean), `To merge` (commits outside
`origin/master`). A row's right side shows unpushed commits `↑n`, commits behind
`↓n`, and the dirty count `•n` (or `clean`).

| Click | What happens |
|---|---|
| a row | focus its space, or make one with `space.new` |
| right-click a row | focus/open, reveal in Finder, copy path, copy branch, diff vs `origin/master`, remove |
| `Clean n` | removes merged + clean + fully pushed checkouts in one go |
| `Merge n` | merges selected branches into one integration branch |

Removing closes the spaces first (a shell in the folder keeps it busy on
Windows), then `git worktree remove` (`--force` only when the dialog said so),
then deletes the branch if the box is ticked — on by default only when every
selected branch is already in master.

Merging builds one integration branch from `origin/master` in a fresh worktree
(`${repo}.worktrees/<slug>`), merges oldest-commit-first with `--no-ff`, and
`merge --abort`s a conflicting branch so no checkout is ever left half-merged.
Nothing shared is touched: no master/test/develop, no force push; the push
button only pushes the new branch. A stale branch holding the name you typed is
reported and can be dropped in one click.

## Data

- `git worktree list --porcelain` — every checkout (the repo's own is skipped)
- `git for-each-ref refs/heads` — last commit per branch
- `git branch --merged` / `--no-merged origin/master` — cleanup and merge sets
- `git status --porcelain=v1 --branch` per checkout — dirty count **and**
  ahead/behind in one call, 4 at a time, refreshed at most every 15 s
- `git rev-list --count origin/master..<branch>` for `To merge` rows only
- spaces, panes and agent states come from the app's live model

The repo shown is the **active space's folder**, then the focused pane's folder,
then the last repo the panel showed (`shared("worktrees.repo")`), so a stray
focused pane in `~/delper-ai` or `~` cannot blank it.

## Gotchas found while building this

- **A dialog can get docked into the layout.** Herdr has, a few times, written an
  open overlay into the shown layout as a 320 px block (`worktrees-menu`,
  `worktrees-merge`), which silently eats terminal width. `mods/worktrees`
  sweeps the layout every 5 s and `layout.hide`s any block whose `content.mod` is
  one of those two.
- **`space.new --task` does not work with opencode.** hc passes the task as a
  positional argument and opencode's positional is a *directory*, so it dies with
  `ENOENT: chdir`. Use `--argv '["opencode","--prompt","<text>"]'` instead.
- **A floating block cannot be hidden with `layout.hide`** from outside; it is
  not in the layout tree. Render nothing and Herdr sizes it to 0×0.
- **Async work must live in `cx.spawn`.** An event handler's context is gone once
  the handler returns, so an `await` there never resumes — this is how a merge
  ran its first branch and stopped.
- **Never run `herdr-app check` on a mod that renders an overlay**: it mounts the
  mod for real with `props()` null. Both overlay mods render nothing without
  `props().overlay`, which also cleans up the leaked copy on the next reload.

## Upgrading Herdr

`tabs-cockpit` is a fork of `mods/tabs` (herdr 0.9.5). After an update, diff them
and port anything unrelated to the Worktrees button:

```bash
diff ~/.config/herdr-app/mods/tabs/main.js ~/.config/herdr-app/mods/tabs-cockpit/main.js
```

## Uninstall

```bash
rm ~/.config/herdr-app/layouts/cockpit.json ~/.config/herdr-app/layouts/cockpit.svg
rm ~/.config/herdr-app/mods/{tabs-cockpit,worktrees,worktrees-menu,worktrees-merge}
herdr-app do layout.switch --name main
```

and drop the `cmd-alt-w` line from `~/.config/herdr-app/keys.json`.
