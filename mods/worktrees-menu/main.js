// Worktrees menu: right-click a row in the worktrees panel, or press its
// Clean button. Opened as a popup/dialog with props:
//   { mode: "row", row, rows, root, on, overlay }
//   { mode: "cleanup", rows, root, on, overlay }
// A row is { path, branch, space, dirty, ahead, merged }.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, exec, props, closeOverlay, theme, notify } from "herdr";

const short = (branch, path) => (branch ?? path?.replace(/\/+$/, "").split("/").pop() ?? "worktree").replace(/^[^/]+\//, "");

async function git(args, on) {
  const r = await exec("git", args, { on: on ?? null });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

export default class WorktreesMenu extends View {
  init(_props, cx) {
    this.step = "menu"; // menu | confirm | working
    this.error = "";
    // Deleting the checkout is not deleting the branch. Default to also dropping
    // the branch when every one of them is already in master (safe).
    this.deleteBranches = this.rows().length > 0 && this.rows().every((r) => r.inMaster);
    this.branchErrors = [];
    this.handle = cx.focus_handle();
    this.handle.focus();
    // Opened with nothing to act on (a check load, a race): close.
    const p = props();
    if (p?.overlay && this.rows().length === 0) closeOverlay(p.overlay);
  }

  close() {
    closeOverlay(props().overlay);
  }

  reveal(path, cx) {
    cx.spawn(async () => {
      const on = props().on;
      const first = on ? await exec("xdg-open", [path], { on }) : await exec("open", [path]);
      if (first.code !== 0) await exec("xdg-open", [path], { on: on ?? null });
      this.close();
    });
  }

  // No stdin in exec: let a shell own the pipe, path as $1 so quoting cannot split it.
  copy(text, cx) {
    cx.spawn(async (ecx) => {
      const on = props().on;
      const r = await exec(
        "sh",
        ["-c", 'printf %s "$1" | pbcopy 2>/dev/null || printf %s "$1" | (xclip -selection clipboard 2>/dev/null || xsel -b 2>/dev/null || wl-copy 2>/dev/null)', "sh", text],
        { on: on ?? null },
      );
      if (r.code !== 0) {
        this.error = "Could not reach the clipboard.";
        ecx.notify();
      } else this.close();
    });
  }

  diff(row) {
    const script = "git log --oneline --graph origin/master..HEAD; echo; git diff --stat origin/master...";
    run("terminal.open", { argv: ["sh", "-c", script], folder: row.path, place: "tab", name: `diff ${short(row.branch, row.path)}` });
    this.close();
  }

  open(row) {
    if (row.space) run("space.select", { id: row.space });
    else run("space.new", { name: short(row.branch, row.path), folder: row.path, machine: props().on ?? "" });
    this.close();
  }

  rows() {
    const p = props() ?? {};
    return p.mode === "cleanup" ? p.rows ?? [] : p.row ? [p.row] : [];
  }

  // Terminals first: a shell sitting in the folder keeps it busy on Windows.
  remove(cx) {
    // In a task, not the handler: an await left in an event handler never resumes.
    cx.spawn(async (ecx) => {
      this.step = "working";
      this.error = "";
      ecx.notify();
      const p = props();
      for (const row of this.rows()) {
        if (row.space) run("space.close", { id: row.space, confirmed: true });
        await ecx.sleep(180);
        const args = ["-C", p.root, "worktree", "remove"];
        if ((row.dirty ?? 0) > 0) args.push("--force");
        args.push(row.path);
        const r = await git(args, p.on);
        if (!r.ok) {
          this.error = r.err || "git worktree remove failed.";
          this.step = "confirm";
          ecx.notify();
          return;
        }
        if (this.deleteBranches && row.branch) {
          const del = await git(["-C", p.root, "branch", "-D", row.branch], p.on);
          if (!del.ok) this.branchErrors.push(`${short(row.branch)}: ${del.err || "git branch -D failed."}`);
        }
      }
      if (this.branchErrors.length) {
        notify({ title: "Some branches were kept", body: this.branchErrors.join("\n"), level: "warning" });
      }
      this.close();
    });
  }

  key(e, cx) {
    if (e.key === "escape") {
      if (this.step === "confirm") {
        this.step = "menu";
        cx.notify();
        cx.stop_propagation();
        return;
      }
      return this.close();
    }
    if (e.key === "enter" && this.step === "confirm") {
      this.remove(cx);
      cx.stop_propagation();
    }
  }

  render(cx) {
    // Opened without props (a check load, a stale copy): draw nothing.
    const p = props();
    if (!p?.overlay) return div().w(0).h(0);
    const t = theme();
    const rows = this.rows();
    const row = rows[0] ?? {};
    const danger = t.blocked ?? "#e5534b";
    const MAX = 8;

    const item = (id, label, action, options = {}) =>
      h_flex()
        .id(id)
        .h(28)
        .px(10)
        .flex_none()
        .items_center()
        .gap(8)
        .rounded(6)
        .text_size(12.5)
        .text_color(options.danger ? danger : t.foreground)
        .hover((s) => s.bg(t.hover))
        // On press: a menu answers at once, and gpui's click waits for the
        // double-click window.
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          action(cx);
        })
        .child(div().flex_1().truncate().child(label))
        .when(Boolean(options.hint), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(options.hint)));

    const line = (r) =>
      h_flex()
        .px(10)
        .h(19)
        .gap(6)
        .items_center()
        .child(div().flex_1().truncate().text_size(11.5).text_color(t.muted).child(short(r.branch, r.path)))
        .when(Boolean(r.space), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child("open")))
        .when((r.dirty ?? 0) > 0, (el) => el.child(div().flex_none().text_size(10).text_color(danger).child(`•${r.dirty}`)));

    const separator = () => div().h(1).my(4).bg(t.border);
    const hint = (text) => h_flex().px(10).pt(4).text_size(10.5).text_color(t.dim).child(text);

    const list = () => [
      ...(rows.length > 1 ? rows.slice(0, MAX).map(line) : []),
      rows.length > MAX ? div().px(10).pt(2).text_size(10.5).text_color(t.dim).child(`+${rows.length - MAX} more`) : null,
    ].filter(Boolean);

    const dirty = rows.reduce((n, r) => n + (r.dirty ?? 0), 0);
    const ahead = rows.reduce((n, r) => n + (r.ahead ?? 0), 0);
    const openSpaces = rows.filter((r) => r.space).length;
    // Branches that are not in master: deleting them loses those commits.
    const lostBranches = rows.filter((r) => !r.inMaster);

    const menuBody = () => [
      h_flex()
        .px(10)
        .pb(2)
        .items_center()
        .child(div().flex_1().truncate().text_size(12).font_semibold().text_color(t.foreground).child(rows.length === 1 ? short(row.branch, row.path) : `${rows.length} merged checkouts`))
        .when(Boolean(rows.length === 1 && row.merged), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("merged"))),
      ...list(),
      rows.length === 1 ? separator() : null,
      rows.length === 1 ? item("wt-open", row.space ? "Focus its space" : "Open in a new space", () => this.open(row)) : null,
      rows.length === 1 ? item("wt-reveal", "Reveal in Finder", (cx) => this.reveal(row.path, cx)) : null,
      rows.length === 1 ? item("wt-copy-path", "Copy path", (ecx) => this.copy(row.path, ecx)) : null,
      rows.length === 1 ? item("wt-copy-branch", "Copy branch", (ecx) => this.copy(row.branch ?? "", ecx)) : null,
      rows.length === 1 ? item("wt-diff", "Diff against origin/master", () => this.diff(row)) : null,
      separator(),
      item("wt-remove", rows.length === 1 ? "Remove worktree…" : `Remove all ${rows.length}…`, (ecx) => { this.step = "confirm"; ecx.notify(); }, { danger: true }),
      hint("esc close"),
    ].filter(Boolean);

    const confirmBody = () => [
      h_flex()
        .px(10)
        .items_center()
        .child(div().flex_1().truncate().text_size(13).font_semibold().text_color(t.foreground).child(rows.length === 1 ? `Remove ${short(row.branch, row.path)}?` : `Remove ${rows.length} checkouts?`)),
      ...list(),
      dirty > 0 ? div().px(10).pt(4).text_size(11.5).text_color(danger).child(`${dirty} uncommitted change${dirty === 1 ? "" : "s"} will be lost.`) : null,
      ahead > 0 ? div().px(10).pt(2).text_size(11.5).text_color(danger).child(`${ahead} commit${ahead === 1 ? "" : "s"} not pushed anywhere will be lost.`) : null,
      openSpaces > 0 ? div().px(10).pt(2).text_size(11.5).text_color(t.muted).child(`${openSpaces} space${openSpaces === 1 ? "" : "s"} will be closed first.`) : null,
      h_flex()
        .id("wt-rm-branch")
        .px(10)
        .pt(4)
        .gap(7)
        .items_center()
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (e, ecx) => {
          ecx.stop_propagation();
          this.deleteBranches = !this.deleteBranches;
          ecx.notify();
        })
        .child(
          h_flex()
            .size(13)
            .flex_none()
            .rounded(3)
            .border(1)
            .border_color(this.deleteBranches ? t.accent : t.input)
            .when(this.deleteBranches, (el) => el.bg(t.accent))
            .items_center()
            .justify_center()
            .child(this.deleteBranches ? div().text_size(9).text_color(t.background ?? "#000").child("✓") : div()),
        )
        .child(div().text_size(11.5).text_color(t.foreground).child(rows.length === 1 ? "delete the branch" : "delete the branches")),
      lostBranches.length
        ? div().px(10).pt(2).text_size(11.5).text_color(danger).child(`${lostBranches.map((r) => `${short(r.branch)} (${r.aheadMaster || "?"})`).join(", ")} not in master — deleting ${lostBranches.length === 1 ? "it" : "them"} loses those commits.`)
        : div().px(10).pt(2).text_size(11).text_color(t.dim).child(this.deleteBranches ? "The branch is deleted after its checkout." : "The branch stays."),
      this.error ? div().px(10).pt(2).text_size(11.5).text_color(danger).child(this.error) : null,
      h_flex().justify_end().gap(8).px(10).pt(6)
        .child(
          h_flex().h(28).px(12).items_center().rounded(7).border_1().border_color(t.input).text_size(12).text_color(t.foreground).cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, ecx) => { this.step = "menu"; ecx.notify(); }).child("Cancel"),
        )
        .child(
          h_flex().h(28).px(12).items_center().rounded(7).bg(danger).text_size(12).text_color(t.solid_foreground ?? "#ffffff").cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, ecx) => this.remove(ecx)).child("Remove"),
        ),
    ].filter(Boolean);

    return v_flex()
      .id("worktrees-menu")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .p(6)
      .gap(1)
      .rounded(8)
      .bg(t.popover)
      .text_size(12.5)
      .when(this.step === "working", (el) =>
        el.child(h_flex().p(10).gap(8).items_center().child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)).child("Removing…")),
      )
      .when(this.step === "menu", (el) => el.children(menuBody()))
      .when(this.step === "confirm", (el) => el.children(confirmBody()));
  }
}
