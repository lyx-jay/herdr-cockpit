// Worktrees: every checkout of the repository the focused space is in, floating
// over the terminal area. Click a row to switch to its space (or make one).
// State comes from `git worktree list` plus one `git status` per checkout;
// agent state comes from the app's live space list.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, ScrollHandle } from "gpui-base";
import { spaces, panes, theme, exec, run, shared, setShared, nextCommand, openOverlay, layout } from "herdr";

const OPEN_KEY = "worktrees.open";
// Cheap runs (the checkout list and its refs) often; one `git status` per
// checkout rarely, a few at a time, so the app's exec slots stay free.
const LIST_EVERY = 3000;
const STATUS_EVERY = 15000;
const STATUS_AT_ONCE = 4;

export const isOpen = () => shared(OPEN_KEY) !== false;

// One toggle for the panel, the top-bar button and the keybinding. A floating
// node is not in the layout tree, so `layout.hide` cannot reach it: the block
// hides by rendering nothing, which shrinks it to 0x0.
export function setOpen(value) {
  setShared(OPEN_KEY, value);
}

const base = (path) => path.replace(/\/+$/, "").split("/").pop();
const inside = (path, dir) => path === dir || path.startsWith(dir + "/");

function ago(at) {
  if (!at) return "";
  const s = Date.now() / 1000 - at;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d`;
  return `${Math.round(s / 86400 / 30)}mo`;
}

// Lower sorts first: what needs a person, then what is open, then the rest.
function rank(row) {
  if (row.status === "blocked") return 0;
  if (row.status === "working") return 1;
  if (row.space) return 2;
  if (row.merged) return 4;
  return 3;
}

async function git(cwd, args, on) {
  try {
    const r = await exec("git", args, { cwd, on: on ?? null });
    return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
  } catch (error) {
    return { ok: false, out: "", err: String(error?.message ?? error) };
  }
}

// `git worktree list --porcelain`: blank-line separated blocks. The first is
// the repository's own checkout, which is not a worktree and not shown.
function parseCheckouts(text) {
  const out = [];
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
    if (!path) continue;
    const ref = lines.find((line) => line.startsWith("branch "))?.slice(7) ?? null;
    out.push({
      path,
      head: lines.find((line) => line.startsWith("HEAD "))?.slice(5) ?? "",
      branch: ref ? ref.replace(/^refs\/heads\//, "") : null,
      main: out.length === 0,
      detached: lines.includes("detached"),
      bare: lines.includes("bare"),
      prunable: lines.some((line) => line.startsWith("prunable")),
    });
  }
  return out;
}

// Where a space is now: its first terminal's live folder, else where it was made.
function placeOf(space, ps) {
  const tabs = new Set((space.tabs ?? []).map((tab) => tab.id));
  return ps.find((pane) => tabs.has(pane.tab) && pane.cwd)?.cwd ?? space.folder ?? null;
}

function focus() {
  const ps = panes();
  const space = spaces().find((s) => s.active) ?? null;
  const focused = ps.find((pane) => pane.focused && pane.cwd);
  return { cwd: focused?.cwd ?? (space ? placeOf(space, ps) : null), on: space?.machine ?? null };
}

export default class Worktrees extends View {
  init(_props, cx) {
    this.key = null; // [machine, folder] the current repo was read for
    this.repo = undefined; // { main, name } | null (not a repo)
    this.checkouts = [];
    this.status = {}; // path -> { dirty, ahead, behind, at }
    this.aheadMaster = {}; // path -> { n, at }: commits outside origin/master
    this.mergedSet = new Set();
    this.pendingSet = new Set();
    this.filter = "all"; // in memory only: a reload starts from everything
    this.refreshing = false;
    this.error = "";
    this.scroll = ScrollHandle.new();
    this.refresh(cx);
    cx.timer.every(LIST_EVERY, (cx) => {
      if (isOpen()) this.refresh(cx);
    });
      // Herdr can write an open overlay into the shown layout as a block (a drag
    // or a layout write while a dialog is up). Our mods are dialogs, never
    // layout blocks: hide any that show up so they stop taking width.
    const sweep = () => this.hideDocked();
    sweep();
    cx.timer.every(5000, () => sweep());
  // Keys: `mod:worktrees` in keys.json sends these (see ~/.config/herdr-app/keys.json).
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "toggle") setOpen(!isOpen());
        else if (command === "refresh") this.refresh(cx);
        cx.notify();
      }
    });
  }

  hideDocked() {
    const walk = (node) => {
      const mod = node?.content?.mod;
      if ((mod === "worktrees-menu" || mod === "worktrees-merge") && !node.hidden) {
        run("layout.hide", { id: node.id });
      }
      for (const child of node?.children ?? []) walk(child);
    };
    walk(layout());
  }

  refresh(cx) {
    if (this.refreshing) return;
    // A task, not the caller: the refresh button hands over an event context.
    cx.spawn(async (ecx) => this.load(ecx));
  }

  async load(cx) {
    this.refreshing = true;
    try {
      const ps = panes();
      const space = spaces().find((s) => s.active) ?? null;
      const on = space?.machine ?? null;
      // The shown space first: a stray focused pane can sit in a folder above
      // any repo (a home folder, a parent), and that is no reason to go blank.
      const folders = [...new Set([space ? placeOf(space, ps) : null, ps.find((pane) => pane.focused && pane.cwd)?.cwd].filter(Boolean))];
      // Last repo this panel showed: survives a reload and a focus in a folder
      // that is not a repo (a home folder, a parent).
      const remembered = shared("worktrees.repo");
      if (!this.repo && remembered?.folder) folders.push(remembered.folder);
      let found = false;
      for (const folder of folders) {
        const key = JSON.stringify([on, folder]);
        if (key === this.key) {
          found = true;
          break;
        }
        const repo = await this.repoOf(folder, on);
        if (repo) {
          this.repo = repo;
          this.key = key;
          this.on = on;
          this.status = {};
          this.aheadMaster = {};
          if (remembered?.folder !== folder) setShared("worktrees.repo", { folder, on });
          found = true;
          break;
        }
      }
      // Focus left every repo: keep the last one on screen instead of going blank.
      if (!found && !this.repo) {
        this.repo = null;
        this.key = null;
        this.checkouts = [];
      }
      if (this.repo) await this.read(this.on ?? null);
      this.error = "";
    } catch (error) {
      this.error = String(error?.message ?? error);
    }
    this.refreshing = false;
    cx.notify();
  }

  // The repo a folder belongs to: its main checkout and name.
  async repoOf(folder, on) {
    const [top, common] = await Promise.all([
      git(folder, ["rev-parse", "--show-toplevel"], on),
      git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on),
    ]);
    if (!top.ok || !common.ok) return null;
    const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
    return { main, name: base(main) };
  }

  async read(on) {
    const repo = this.repo;
    const [list, refs, merged, pending] = await Promise.all([
      git(repo.main, ["worktree", "list", "--porcelain"], on),
      git(repo.main, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], on),
      git(repo.main, ["branch", "--merged", "origin/master", "--format=%(refname:short)"], on),
      // The complement: branches with commits that are not in master yet.
      git(repo.main, ["branch", "--no-merged", "origin/master", "--format=%(refname:short)"], on),
    ]);
    if (!list.ok) {
      this.checkouts = [];
      this.error = list.err || "git worktree list failed.";
      return;
    }
    const when = new Map();
    if (refs.ok) {
      for (const line of refs.out.split("\n")) {
        const [branch, at] = line.split("\t");
        if (branch) when.set(branch, Number(at) || 0);
      }
    }
    const done = new Set(merged.ok ? merged.out.split("\n").filter(Boolean) : []);
    this.mergedSet = done;
    // The "in integration-…" marker outlives the branch when that branch is
    // deleted (or its worktree removed): drop it once the branch is gone.
    const marker = shared("worktrees.integration");
    if (marker?.branch && !done.has(marker.branch)) {
      const alive = await git(repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${marker.branch}`], on);
      if (!alive.ok) setShared("worktrees.integration", null);
    }
    this.pendingSet = new Set(pending.ok ? pending.out.split("\n").filter(Boolean) : []);
    this.checkouts = parseCheckouts(list.out).map((c) => ({
      ...c,
      at: c.branch ? (when.get(c.branch) ?? 0) : 0,
      merged: Boolean(c.branch && done.has(c.branch)),
    }));
    // Dirty state is the expensive part: the oldest few, a batch at a time.
    const now = Date.now();
    const due = this.checkouts
      .filter((c) => !c.main && (!this.status[c.path] || now - this.status[c.path].at > STATUS_EVERY))
      .slice(0, STATUS_AT_ONCE);
    await Promise.all(
      due.map(async (c) => {
        this.status[c.path] = { ...(await this.statusOf(c.path, on)), at: Date.now() };
      }),
    );
    // How many commits each pending branch has outside master: only for those,
    // and only when its entry is stale.
    const stale = this.checkouts
      .filter((c) => !c.main && c.branch && this.pendingSet.has(c.branch) && (!this.aheadMaster[c.path] || now - this.aheadMaster[c.path].at > STATUS_EVERY))
      .slice(0, STATUS_AT_ONCE);
    await Promise.all(
      stale.map(async (c) => {
        const r = await git(repo.main, ["rev-list", "--count", `origin/master..${c.branch}`], on);
        this.aheadMaster[c.path] = { n: Number(r.out) || 0, at: Date.now() };
      }),
    );
  }

  // One call gives both the dirty count and ahead/behind: `## branch...upstream [ahead 2, behind 1]`.
  async statusOf(path, on) {
    const r = await git(path, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--branch"], on);
    if (!r.ok) return { dirty: null, ahead: 0, behind: 0, detached: false };
    const lines = r.out ? r.out.split("\n") : [];
    const head = lines[0]?.startsWith("## ") ? lines.shift() : "";
    const counts = /\[([^\]]*)\]/.exec(head)?.[1] ?? "";
    return {
      dirty: lines.filter((line) => line.trim()).length,
      ahead: Number(/ahead (\d+)/.exec(counts)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(counts)?.[1] ?? 0),
      detached: /^## (HEAD|No commits yet on )/.test(head),
    };
  }

  // Checkouts joined with the space that has a terminal in them and their git state.
  rows() {
    // Set by the merge dialog; drop the marker once that branch is in master.
    const stored = shared("worktrees.integration");
    const integration = stored && stored.branch && !this.mergedSet.has(stored.branch) ? stored : null;
    const ps = panes();
    const spaces_ = spaces();
    const places = spaces_.map((s) => ({ id: s.id, status: s.status, at: placeOf(s, ps) }));
    const all = this.checkouts;
    const rows = [];
    for (const c of all) {
      if (c.main || c.bare || c.prunable) continue;
      // The deepest checkout wins: a terminal in a nested worktree is not in its parent's.
      const there = places.find(
        (p) => p.at && inside(p.at, c.path) && !all.some((o) => o.path !== c.path && o.path.length > c.path.length && inside(p.at, o.path)),
      );
      const st = this.status[c.path];
      rows.push({
        path: c.path,
        branch: c.branch,
        main: c.main,
        // "in master" is a fact about the branch; "merged" (done, safe to drop)
        // also needs a clean tree: an uncommitted worktree is still work.
        inMaster: c.merged,
        merged: c.merged && st?.dirty === 0,
        // Commits outside master: what a merge would bring in.
        pending: Boolean(c.branch && this.pendingSet.has(c.branch)),
        aheadMaster: this.aheadMaster[c.path]?.n ?? 0,
        inIntegration: integration?.branches?.includes(c.branch) ? integration.branch : null,
        at: c.at,
        space: there?.id ?? null,
        status: there?.status ?? null,
        dirty: st?.dirty ?? null,
        ahead: st?.ahead ?? 0,
        behind: st?.behind ?? 0,
        detached: c.detached || Boolean(st?.detached),
      });
    }
    return rows;
  }

  // `all`: rows() of this render, so one panes()/spaces() read serves both the
  // list and the Clean count.
  shown(all = this.rows()) {
    const keep =
      this.filter === "active"
        ? (row) => row.status === "working" || row.status === "blocked"
        : this.filter === "dirty"
          ? (row) => (row.dirty ?? 0) > 0
          : this.filter === "merged"
            ? (row) => row.merged
            : this.filter === "merge"
              ? (row) => row.pending && !row.detached
              : () => true;
    return all
      .filter(keep)
      .sort((a, b) => rank(a) - rank(b) || b.at - a.at);
  }

  pick(filter, cx) {
    this.filter = filter;
    cx.notify();
  }

  open(row, cx) {
    const existing = spaces().find((s) => s.id === row.space);
    if (existing) return run("space.select", { id: existing.id });
    const name = (row.branch ?? base(row.path)).replace(/^[^/]+\//, "");
    run("space.new", { name, folder: row.path, machine: focus().on ?? "" });
    cx.notify();
  }

  // The merge dialog: branches with commits outside master, one integration
  // branch built from origin/master, its own worktree.
  mergeDialog(rows, skipped, cx) {
    if (!this.repo) return;
    openOverlay({
      mod: "worktrees-merge",
      kind: "dialog",
      width: 430,
      props: {
        rows: rows.map((r) => ({ path: r.path, branch: r.branch, aheadMaster: r.aheadMaster, at: r.at })),
        skipped,
        root: this.repo.main,
        on: focus().on ?? null,
      },
    });
    cx.notify();
  }

  // One menu for a right-clicked row and for the Clean button's batch.
  menu(kind, rows, cx, at) {
    if (!this.repo) return;
    openOverlay({
      mod: "worktrees-menu",
      kind,
      width: kind === "popup" ? 250 : 360,
      ...(at ? { at: { x: Math.max(8, at.x - 6), y: Math.max(8, at.y - 6) } } : {}),
      props: {
        mode: rows.length > 1 ? "cleanup" : "row",
        row: rows[0] ?? null,
        rows,
        root: this.repo.main,
        on: focus().on ?? null,
      },
    });
    cx.notify();
  }

  render(cx) {
    if (!isOpen()) return div().w(0).h(0);
    const t = theme();
    const all = this.rows();
    const rows = this.shown(all);
    // Merged, clean and fully pushed: the safe batch behind the Clean button.
    const candidates = all.filter((r) => r.merged && r.ahead === 0);
    // To merge: commits outside master, nothing uncommitted, no agent mid-flight.
    const mergeable = all.filter((r) => r.pending && !r.detached && r.dirty === 0 && r.status !== "working" && r.status !== "blocked");
    const skippedForMerge = all
      .filter((r) => r.pending && !r.detached && !mergeable.includes(r))
      .map((r) => ({ branch: r.branch, why: (r.dirty ?? 0) > 0 ? `${r.dirty} uncommitted` : r.status === "working" ? "agent running" : "agent blocked" }));
    const total = this.checkouts.filter((c) => !c.main && !c.bare && !c.prunable).length;
    const stop = (_e, cx) => cx.stop_propagation();
    const chip = (id, label, active) =>
      h_flex()
        .id(`wt-filter-${id}`)
        .h(22)
        .px(7)
        .flex_none()
        .items_center()
        .rounded(5)
        .text_size(11)
        .bg(active ? t.selected : t.chrome)
        .text_color(active ? t.foreground : t.muted)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        // On press, not click: a floating block's click waits for the drag/double-click window.
        .on_mouse_down("left", (_e, cx) => {
          cx.stop_propagation();
          if (active) return;
          this.pick(id, cx);
        })
        .child(label);
    const icon = (id, glyph, action) =>
      h_flex()
        .id(id)
        .size(22)
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(5)
        .text_size(12)
        .text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => action(cx))
        .child(glyph);

    const dot = (row) => {
      if (row.space) {
        return div()
          .size(7)
          .flex_none()
          .rounded(4)
          .bg(t[row.status] ?? t.working);
      }
      if (row.merged) return div().size(7).flex_none().rounded(4).border(1).border_color(t.dim);
      return div().size(7).flex_none().rounded(4).border(1).border_color(t.muted);
    };

    const counts = (row) =>
      h_flex()
        .flex_none()
        .gap(4)
        .items_center()
        .text_size(10.5)
        .when(row.ahead > 0, (el) => el.child(div().text_color(t.accent).child(`↑${row.ahead}`)))
        .when(row.behind > 0, (el) => el.child(div().text_color(t.dim).child(`↓${row.behind}`)))
        .when((row.dirty ?? 0) > 0, (el) => el.child(div().text_color(t.blocked).child(`•${row.dirty}`)))
        .when(row.dirty === 0, (el) => el.child(div().text_color(t.dim).child("clean")))
        .when(row.detached, (el) => el.child(div().text_color(t.dim).child("detached")));

    const subline = (row) => {
      const where = row.space
        ? row.status === "blocked"
          ? "needs you"
          : row.status === "working"
            ? "working"
            : row.status === "done"
              ? "done"
              : "idle"
        : row.merged
          ? "merged into master"
          : row.inMaster
            ? "tip in master"
            : "not open";
      const bits = [where];
      if (row.inIntegration) bits.push(`in ${row.inIntegration.replace(/^[^/]+\//, "")}`);
      else if (row.pending && row.aheadMaster > 0) bits.push(`${row.aheadMaster} to merge`);
      if (row.at && !(row.merged && !row.space)) bits.push(`${ago(row.at)} ago`);
      return bits.join(" · ");
    };

    const row = (r) =>
      v_flex()
        .id(`wt-${r.path}`)
        .flex_none()
        .h(50)
        .px(8)
        .py(4)
        .gap(1)
        .rounded(6)
        .justify_center()
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", stop)
        .on_mouse_down("right", (e, cx) => {
          cx.stop_propagation();
          // Herdr's own pointer tracking does not follow a right press here, so
          // the popup would open where the last left click was: pass the spot.
          this.menu("popup", [r], cx, e.position);
        })
        .on_click((_e, cx) => this.open(r, cx))
        .child(
          h_flex()
            .gap(7)
            .items_center()
            .child(dot(r))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(12.5)
                .text_color(r.merged && !r.space ? t.dim : t.foreground)
                .child(r.branch ?? base(r.path)),
            )
            .child(counts(r)),
        )
        .child(
          h_flex()
            .gap(6)
            .pl(14)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(subline(r))),
        );

    return v_flex()
      .id("worktrees")
      .w(408)
      // A fixed frame: a filter change redraws rows without resizing the
      // floating block (Herdr animates that, and it made switching feel slow).
      .h(548)
      .px(6)
      .py(2)
      .gap(4)
      .text_size(12)
      .child(
        h_flex()
          .h(28)
          .px(6)
          .gap(7)
          .items_center()
          .child(div().flex_none().text_color(t.dim).child("⠿"))
          .child(div().flex_none().font_semibold().text_size(11).text_color(t.muted).child("WORKTREES"))
          .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.repo ? this.repo.name : ""))
          .child(div().flex_1())
          .child(div().flex_none().text_size(11).text_color(t.dim).child(String(rows.length === total ? total : `${rows.length}/${total}`)))
          .child(icon("wt-refresh", "⟳", (cx) => this.refresh(cx)))
          .child(icon("wt-close", "✕", () => setOpen(false))),
      )
      .child(
        h_flex()
          .gap(4)
          .px(6)
          .children([
            chip("all", "All", this.filter === "all"),
            chip("active", "Running", this.filter === "active"),
            chip("dirty", "Dirty", this.filter === "dirty"),
            chip("merged", "Merged", this.filter === "merged"),
            chip("merge", "To merge", this.filter === "merge"),
          ])
          .when(candidates.length > 0 || mergeable.length > 0, (el) => el.child(div().flex_1()))
          .when(mergeable.length > 0, (el) =>
            el.child(
              h_flex()
                .id("wt-merge")
                .h(22)
                .px(7)
                .flex_none()
                .items_center()
                .rounded(5)
                .text_size(11)
                .text_color(t.foreground)
                .bg(t.selected)
                .hover((s) => s.bg(t.hover))
                .on_mouse_down("left", stop)
                .on_click((_e, cx) => this.mergeDialog(mergeable, skippedForMerge, cx))
                .child(`Merge ${mergeable.length}`),
            ),
          )
          .when(candidates.length > 0, (el) =>
            el.child(
              h_flex()
                .id("wt-clean")
                .h(22)
                .px(7)
                .flex_none()
                .items_center()
                .rounded(5)
                .text_size(11)
                .text_color(t.accent)
                .bg(t.chrome)
                .hover((s) => s.bg(t.hover))
                .on_mouse_down("left", stop)
                .on_click((_e, cx) => this.menu("dialog", candidates, cx))
                .child(`Clean ${candidates.length}`),
            ),
          ),
      )
      .when(!this.repo || (this.checkouts.length === 0 && this.refreshing), (el) =>
        el.child(div().px(6).py(10).text_color(t.muted).child(this.repo === null ? "Focus a space inside a git repository." : "…")),
      )
      .when(Boolean(this.error), (el) => el.child(div().px(6).py(6).text_color(t.blocked).child(this.error)))
      .when(rows.length > 0, (el) =>
        el.child(
          div()
            .relative()
            .flex_1()
            .min_h(0)
            .child(
              v_flex()
                .id("wt-rows")
                .size_full()
                .gap(1)
                .overflow_y_scroll()
                .track_scroll(this.scroll)
                .children(rows.map(row)),
            )
            .child(Scrollbar.vertical("wt-rows").absolute().inset_0()),
        ),
      )
      .when(rows.length === 0 && this.repo && !this.refreshing, (el) =>
        el.child(div().px(6).py(10).text_color(t.dim).child("No worktrees match.")),
      )
      .child(
        h_flex()
          .px(6)
          .pb(2)
          .gap(6)
          .text_size(10.5)
          .text_color(t.dim)
          .child(div().flex_none().child("click to open"))
          .child(div().flex_none().child("·"))
          .child(div().flex_none().child("⌘⌥W toggles")),
      );
  }
}
