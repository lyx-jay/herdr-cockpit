// Worktrees merge: take the selected checkouts' branches and merge them, in
// order, into one new integration branch built from origin/master, in its own
// worktree. Nothing shared is touched: no master/test/develop, no force push.
//
// Opened as a dialog with props { rows, skipped, root, on, overlay }.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Scrollbar, ScrollHandle } from "gpui-base";
import { run, exec, props, closeOverlay, theme, setShared, spaces } from "herdr";

const BASE = "origin/master";

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on: on ?? null });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

// `lvyuanxin/integration-20261123-1540` -> `integration-20261123-1540`
const slug = (branch) => branch.replace(/^[^/]+\//, "").replace(/[^A-Za-z0-9._-]+/g, "-");
const short = (branch) => (branch ?? "").replace(/^[^/]+\//, "");

// Conflicts git reports as "CONFLICT (content): Merge conflict in <path>".
const conflictFiles = (text) =>
  [...new Set([...String(text).matchAll(/Merge conflict in (.+)$/gm)].map((m) => m[1].trim()))];

export default class WorktreesMerge extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.root = p.root ?? "";
    this.on = p.on ?? null;
    this.rows = (p.rows ?? []).map((row) => ({ ...row, checked: true, mayConflict: false }));
    this.skipped = p.skipped ?? [];
    this.step = "confirm"; // confirm | working | done
    this.log = [];
    this.error = "";
    this.path = "";
    this.integration = "";
    this.pushed = false;
    this.busy = false;
    this.exists = null; // a stale branch holding this name
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ value: "", placeholder: "integration branch" });
    this.input.on("change", (_e, cx) => {
      this.integration = this.input.value();
      this.error = "";
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.merge(cx));
    this.inputFocused = false;
    this.input.on("focus", (_e, cx) => {
      this.inputFocused = true;
      cx.notify();
    });
    this.input.on("blur", (_e, cx) => {
      this.inputFocused = false;
      cx.notify();
    });
    this.handle = cx.focus_handle();
    this.handle.focus();
    // Opened with nothing to merge (a check load, a stale copy): draw nothing.
    if (!p.overlay) return;
    cx.spawn(async (cx) => {
      const user = await git(this.root, ["config", "user.name"], this.on);
      const name = `${(user.ok && user.out) || "me"}/integration-${stamp()}`;
      this.integration = name;
      this.input.set_value(name);
      // Pre-flight against the base only: tells the person what to expect; the
      // real answer comes from merging the branches one after another.
      for (const row of this.rows) {
        const t = await git(this.root, ["merge-tree", "--write-tree", "--no-messages", BASE, row.branch], this.on);
        row.mayConflict = t.ok === false;
      }
      this.handle.focus();
      cx.timer.after(120, () => this.input.focus());
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  chosen() {
    return this.rows.filter((r) => r.checked);
  }

  toggle(row, cx) {
    if (this.step !== "confirm") return;
    row.checked = !row.checked;
    cx.notify();
  }

  merge(cx) {
    if (this.busy) return;
    const chosen = this.chosen();
    if (!chosen.length) {
      this.error = "Select at least one branch.";
      cx.notify();
      return;
    }
    const name = (this.integration ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.endsWith("/") || name.includes("..")) {
      this.error = "That is not a usable branch name.";
      cx.notify();
      return;
    }
    // Async work belongs in a task: an event handler's context ends when the
    // handler returns, and an await after that never continues.
    cx.spawn(async (ecx) => this.start(ecx, chosen, name));
  }

  // A name left over from an earlier attempt (its worktree gone, its branch not)
  // is not a dead end: say what it holds and let the person drop it in one step.
  async start(cx, chosen, name) {
    const exists = await git(this.root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], this.on);
    if (exists.ok) {
      const ahead = await git(this.root, ["rev-list", "--count", `origin/master..${name}`], this.on);
      const list = await git(this.root, ["worktree", "list", "--porcelain"], this.on);
      const checkedOut = Boolean(
        list.ok && list.out.split(/\n\n+/).some((block) => block.split("\n").includes(`branch refs/heads/${name}`)),
      );
      this.exists = { name, ahead: Number(ahead.out) || 0, checkedOut };
      this.step = "exists";
      cx.notify();
      return;
    }
    await this.run(cx, chosen, name);
  }

  dropStale(cx) {
    cx.spawn(async (ecx) => {
      const name = this.exists?.name;
      if (!name) return;
      const del = await git(this.root, ["branch", "-D", name], this.on);
      if (!del.ok) {
        this.error = del.err || "git branch -D failed.";
        ecx.notify();
        return;
      }
      this.exists = null;
      this.step = "confirm";
      ecx.notify();
      this.merge(ecx);
    });
  }

  async run(cx, chosen, name) {
    this.busy = true;
    this.step = "working";
    this.error = "";
    this.log = [];
    cx.notify();

    const path = `${this.root}.worktrees/${slug(name)}`;
    const add = await git(this.root, ["worktree", "add", "--no-track", "-b", name, path, BASE], this.on);
    if (!add.ok) {
      this.error = add.err || "git worktree add failed.";
      this.step = "confirm";
      this.busy = false;
      cx.notify();
      return;
    }
    this.path = path;

    // Oldest last commit first: the least history to replay, the fewest surprises.
    const order = [...chosen].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    for (const row of order) {
      const m = await git(path, ["merge", "--no-ff", "-m", `merge branch '${row.branch}' into ${name}`, row.branch], this.on);
      if (!m.ok) {
        // Never leave a half-merged checkout behind.
        await git(path, ["merge", "--abort"], this.on);
        this.log.push({ branch: row.branch, ok: false, files: conflictFiles(`${m.out}\n${m.err}`) });
      } else {
        this.log.push({ branch: row.branch, ok: true, upToDate: /already up to date/i.test(m.out) });
      }
      cx.notify();
    }

    const merged = this.log.filter((l) => l.ok).map((l) => l.branch);
    if (merged.length) setShared("worktrees.integration", { branch: name, branches: merged });
    this.busy = false;
    this.step = "done";
    cx.notify();
  }

  openSpace(cx) {
    const existing = spaces().find((s) => s.folder === this.path);
    if (existing) run("space.select", { id: existing.id });
    else run("space.new", { name: slug(this.integration), folder: this.path, machine: this.on ?? "" });
    cx.notify();
  }

  push(cx) {
    if (this.busy || this.pushed) return;
    cx.spawn(async (ecx) => {
      this.busy = true;
      this.error = "";
      ecx.notify();
      const r = await git(this.path, ["push", "-u", "origin", this.integration], this.on);
      if (!r.ok) this.error = r.err || "git push failed.";
      else this.pushed = true;
      this.busy = false;
      ecx.notify();
    });
  }

  render(cx) {
    const p = props();
    if (!p?.overlay) return div().w(0).h(0);
    const t = theme();
    const chosen = this.chosen();
    const danger = t.blocked ?? "#e5534b";
    const ok = this.log.filter((l) => l.ok).length;

    const button = (id, label, action, options = {}) =>
      h_flex()
        .id(id)
        .h(28)
        .px(12)
        .items_center()
        .rounded(7)
        .text_size(12)
        .text_color(options.primary ? (t.solid_foreground ?? "#ffffff") : options.danger ? danger : t.foreground)
        .when(Boolean(options.primary), (el) => el.bg(options.danger ? danger : t.solid))
        .when(!options.primary, (el) => el.border_1().border_color(t.input))
        .when(Boolean(options.disabled), (el) => el.opacity(0.5))
        .cursor_pointer()
        .hover((s) => s.opacity(0.85))
        .on_click((_e, ecx) => {
          if (options.disabled) return;
          action(ecx);
        })
        .child(label);

    const check = (row) =>
      v_flex()
        .id(`mg-${row.path}`)
        .flex_none()
        .h(22)
        .px(2)
        .rounded(5)
        .justify_center()
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (e, ecx) => {
          ecx.stop_propagation();
          this.toggle(row, ecx);
        })
        .child(
          h_flex()
            .gap(7)
            .items_center()
            .child(
              h_flex()
                .size(13)
                .flex_none()
                .rounded(3)
                .border(1)
                .border_color(row.checked ? t.accent : t.input)
                .when(row.checked, (el) => el.bg(t.accent))
                .items_center()
                .justify_center()
                .child(row.checked ? div().text_size(9).text_color(t.background ?? "#000").child("✓") : div()),
            )
            .child(div().flex_1().truncate().text_size(11.5).text_color(t.foreground).child(short(row.branch)))
            .when(row.mayConflict, (el) => el.child(div().flex_none().text_size(10).text_color(danger).child("may conflict")))
            .when(!row.mayConflict && (row.aheadMaster ?? 0) > 0, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(`${row.aheadMaster} commit${row.aheadMaster === 1 ? "" : "s"}`))),
        );

    const confirmBody = () => [
      h_flex()
        .px(10)
        .items_center()
        .child(div().flex_1().text_size(13).font_semibold().text_color(t.foreground).child(`Merge ${chosen.length} branch${chosen.length === 1 ? "" : "es"}`))
        .child(div().text_size(10.5).text_color(t.dim).child("Esc")),
      h_flex()
        .px(10)
        .pb(6)
        .gap(6)
        .items_center()
        .child(div().text_size(11).text_color(t.dim).child(`base ${BASE}`)),
      div().px(10).child(Input.new(this.input).h(28).px(8).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground)),
      div().h(8),
      ...this.rows.map(check),
      this.skipped.length
        ? div()
            .px(10)
            .pt(6)
            .text_size(10.5)
            .text_color(t.dim)
            .child(`skipped: ${this.skipped.map((s) => `${short(s.branch)} (${s.why})`).join(", ")}`)
        : null,
      div().px(10).pt(6).text_size(10.5).text_color(t.dim).child("Uncommitted changes are not part of a merge."),
      this.error ? div().px(10).pt(4).text_size(11.5).text_color(danger).child(this.error) : null,
      h_flex()
        .justify_end()
        .gap(8)
        .px(10)
        .pt(8)
        .child(button("mg-cancel", "Cancel", () => this.close()))
        .child(button("mg-go", `Merge ${chosen.length}`, (ecx) => this.merge(ecx), { primary: true, disabled: chosen.length === 0 })),
    ].filter(Boolean);

    const existsBody = () => {
      const e = this.exists ?? {};
      return [
        h_flex()
          .px(10)
          .items_center()
          .child(div().flex_1().text_size(13).font_semibold().text_color(t.foreground).child("Branch already exists"))
          .child(div().text_size(10.5).text_color(t.dim).child("Esc")),
        div().px(10).pt(2).text_size(11.5).text_color(t.foreground).child(short(e.name)),
        div().px(10).pt(2).text_size(11).text_color(t.muted).child(`${e.ahead ?? 0} commit${e.ahead === 1 ? "" : "s"} not in master`),
        div()
          .px(10)
          .pt(4)
          .text_size(11)
          .text_color(e.checkedOut ? danger : t.dim)
          .child(e.checkedOut ? "It is checked out in a worktree: remove that worktree first." : "No worktree has it: left over from an earlier attempt."),
        e.checkedOut ? null : div().px(10).pt(2).text_size(11).text_color(t.dim).child("Deleting it starts the merge fresh."),
        this.error ? div().px(10).pt(4).text_size(11.5).text_color(danger).child(this.error) : null,
        h_flex()
          .justify_end()
          .gap(8)
          .px(10)
          .pt(8)
          .child(button("mg-x-cancel", "Cancel", () => this.close()))
          .when(!e.checkedOut, (el) =>
            el.child(button("mg-x-drop", "Delete branch and merge", (ecx) => this.dropStale(ecx), { primary: true, danger: true })),
          ),
      ].filter(Boolean);
    };

    const workingBody = () => [
      h_flex().px(10).gap(8).items_center().child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)).child(div().text_size(12.5).text_color(t.foreground).child(`Merging into ${this.integration}`)),
      div().px(10).pt(4).text_size(10.5).text_color(t.dim).child(this.path),
      div().h(6),
      ...this.rows.map((row) => {
        const done = this.log.find((l) => l.branch === row.branch);
        return h_flex()
          .px(10)
          .h(20)
          .gap(7)
          .items_center()
          .child(div().flex_none().text_color(done ? (done.ok ? t.accent : danger) : t.dim).child(done ? (done.ok ? "✓" : "✗") : "·"))
          .child(div().flex_1().truncate().text_size(11.5).text_color(t.muted).child(short(row.branch)));
      }),
    ];

    const doneBody = () => [
      h_flex()
        .px(10)
        .items_center()
        .child(div().flex_1().text_size(13).font_semibold().text_color(t.foreground).child(`Merged ${ok} into ${short(this.integration)}`))
        .child(div().text_size(10.5).text_color(t.dim).child("Esc")),
      div().px(10).text_size(10.5).text_color(t.dim).child(this.path),
      div().h(6),
      ...this.log.map((l) =>
        v_flex()
          .px(10)
          .py(1)
          .child(
            h_flex()
              .gap(7)
              .items_center()
              .child(div().flex_none().text_color(l.ok ? t.accent : danger).child(l.ok ? "✓" : "✗"))
              .child(div().flex_1().truncate().text_size(11.5).text_color(l.ok ? t.foreground : danger).child(short(l.branch)))
              .when(l.upToDate, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child("up to date"))),
          )
          .when(!l.ok && l.files?.length, (el) => el.child(div().pl(14).text_size(10).text_color(t.dim).child(l.files.slice(0, 3).join(", ")))),
      ),
      this.error ? div().px(10).pt(4).text_size(11.5).text_color(danger).child(this.error) : null,
      this.pushed ? div().px(10).pt(4).text_size(11.5).text_color(t.accent).child(`pushed origin/${short(this.integration)}`) : null,
      h_flex()
        .justify_end()
        .gap(8)
        .px(10)
        .pt(8)
        .child(button("mg-space", "Open space", (ecx) => this.openSpace(ecx)))
        .when(ok > 0, (el) =>
          el.child(button("mg-push", this.pushed ? "Pushed" : this.busy ? "Pushing…" : "Push branch", (ecx) => this.push(ecx), { disabled: this.pushed || this.busy })),
        )
        .child(button("mg-close", "Close", () => this.close(), { primary: true })),
    ].filter(Boolean);

    return v_flex()
      .id("worktrees-merge")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.step !== "working") return this.close();
        if (e.key !== "escape") return;
        cx.stop_propagation();
      })
      .p(6)
      .gap(2)
      .rounded(8)
      .bg(t.popover)
      .text_size(12.5)
      .when(this.step === "confirm", (el) => el.children(confirmBody()))
      .when(this.step === "exists", (el) => el.children(existsBody()))
      .when(this.step === "working", (el) => el.children(workingBody()))
      .when(this.step === "done", (el) => el.children(doneBody()));
  }
}
