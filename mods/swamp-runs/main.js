// Swamp runs: recent swamp workflow runs and behavior method runs, newest
// first, in every watched swamp repo. Click a run to see its details, open
// its logs or its summary report in a new tab. Read-only: this panel never
// starts, changes or cancels a run.
//
// Watched repos: REPOS below, props.repos (if a layout gives it), and the
// folder of any open space on this machine that has a .swamp.yaml.
//
// swamp sources (checked on swamp 20261102):
// - `swamp workflow history search --json` -> results[]: runId, workflowName,
//   status, startedAt, duration, stepProgress, failedStep, failureReason
// - `swamp behavior history search --json` -> results[]: id, modelName, type,
//   methodName, status, startedAt, durationMs (no error text)
// - `swamp behavior history get <id> --json` -> error.message (asked on expand)
// - `swamp run history --active --json` -> runs[]: id, runKind, status (running now)

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, exec, hc, home, notify, panes, props, readTextFile, run, setShared, shared, spaces, theme } from "herdr";

const REPOS = []; // extra swamp repos, e.g. ["~/git/my-swamp-repo"]; open spaces with a .swamp.yaml are added automatically
const POLL_MS = 20000;
const LIMIT = 50;
const SEEN_KEY = "swamp-runs.failed-seen";

const expand = (p) => (p.startsWith("~/") ? home() + p.slice(1) : p);
const short = (p) => (p.startsWith(home()) ? "~" + p.slice(home().length) : p);
const base = (p) => p.split("/").filter(Boolean).pop() ?? p;
// One tab per job: find the tab by name; "busy" means a program other than the
// shell still runs in it (the shell waits at its prompt when the job has ended).
function findTab(name) {
  for (const s of spaces()) {
    if (s.machine) continue;
    for (const t of s.tabs) {
      if (t.name !== name) continue;
      const pane = panes().find((p) => p.tab === t.id && p.terminal);
      return { space: s.id, tab: t.id, pane, busy: Boolean(pane && !pane.program?.shell) };
    }
  }
  return null;
}

function showTab(found) {
  run("space.select", { id: found.space });
  run("tab.select", { id: found.tab });
}

const shq = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

// Runs argv in the tab called name: types it into the tab's shell when the tab
// is open and idle, else opens the tab. Returns "busy" (nothing started), "sent"
// or "opened". Must be awaited inside cx.spawn.
async function runInTab(name, folder, argv, clear) {
  const found = findTab(name);
  if (found?.busy) {
    showTab(found);
    return "busy";
  }
  if (found?.pane) {
    showTab(found);
    const line = `${clear ? "clear && " : ""}cd ${shq(folder)} && ${argv.map(shq).join(" ")}`;
    const r = await hc(["send", found.pane.terminal, line]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `hc send exit ${r.code}`);
    return "sent";
  }
  run("tab.new", { name, folder, argv });
  return "opened";
}

// Logs and reports of every run share this one tab.
const LOG_TAB = "swamp logs";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!isFinite(s)) return "";
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function dur(ms) {
  if (ms == null || !isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const i = text.indexOf("{");
    return i >= 0 ? JSON.parse(text.slice(i)) : null;
  }
}

// swamp says "succeeded" in history and "completed" in the run tracker.
const norm = (s) => (s === "completed" ? "succeeded" : s ?? "unknown");

export default class SwampRuns extends View {
  init(_props, cx) {
    this.swamp = "swamp";
    this.runs = []; // merged, newest first
    this.repoErrors = {};
    this.loading = true;
    this.filter = "all"; // all | workflow | method
    this.failedOnly = false;
    this.open = null; // key of the expanded run
    this.details = {}; // key -> { error } for method runs
    this.known = false; // true after the first load (old failures never toast)
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  async findSwamp() {
    try {
      await exec("swamp", ["--version"]);
    } catch {
      this.swamp = home() + "/.local/bin/swamp";
    }
    this.swampChecked = true;
  }

  async repoList() {
    const set = new Set([...REPOS, ...((props() ?? {}).repos ?? [])].map(expand));
    for (const s of spaces()) {
      if (s.machine || !s.folder || set.has(s.folder)) continue;
      if ((await readTextFile(s.folder + "/.swamp.yaml").catch(() => null)) != null) set.add(s.folder);
    }
    return [...set];
  }

  async swampJson(repo, args) {
    const r = await exec(this.swamp, [...args, "--json"], { cwd: repo });
    const data = r.stdout.trim() ? parseJson(r.stdout) : null;
    if (r.code !== 0 && !data) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || `exit ${r.code}`);
    return data;
  }

  async loadRepo(repo) {
    const [wf, bh, active] = await Promise.all([
      this.swampJson(repo, ["workflow", "history", "search"]),
      this.swampJson(repo, ["behavior", "history", "search"]),
      this.swampJson(repo, ["run", "history", "--active"]).catch(() => ({ runs: [] })),
    ]);
    const out = new Map();
    for (const r of wf?.results ?? []) {
      out.set(r.runId, {
        kind: "workflow", repo, id: r.runId, key: `${repo}#${r.runId}`,
        title: r.workflowName, sub: r.triggerSource && r.triggerSource !== "manual" ? `by ${r.triggerSource}` : "",
        status: norm(r.status), startedAt: r.startedAt, ms: r.duration,
        steps: r.stepProgress, failedStep: r.failedStep, error: r.failureReason, inputs: r.inputs,
        workflowName: r.workflowName,
      });
    }
    for (const r of bh?.results ?? []) {
      out.set(r.id, {
        kind: "method", repo, id: r.id, key: `${repo}#${r.id}`,
        title: `${r.modelName} → ${r.methodName}`, sub: r.type,
        status: norm(r.status), startedAt: r.startedAt, ms: r.durationMs,
        modelName: r.modelName,
      });
    }
    // Runs that operate now: mark them, or add them if history has no row yet.
    for (const r of active?.runs ?? []) {
      const row = out.get(r.id);
      if (row) row.status = "running";
      else {
        const wfRun = r.runKind === "workflow";
        out.set(r.id, {
          kind: wfRun ? "workflow" : "method", repo, id: r.id, key: `${repo}#${r.id}`,
          title: wfRun ? r.workflowName : `${r.modelType ?? "?"} → ${r.methodName ?? "?"}`,
          sub: r.stale ? "stale: no heartbeat" : "", status: "running", startedAt: r.startedAt,
          workflowName: r.workflowName,
        });
      }
    }
    return [...out.values()];
  }

  refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.swampChecked) await this.findSwamp();
        const repos = await this.repoList();
        const results = await Promise.all(repos.map((repo) =>
          this.loadRepo(repo).then((runs) => ({ repo, runs }), (e) => ({ repo, runs: [], error: String(e?.message ?? e) }))));
        this.repoErrors = {};
        const all = [];
        for (const r of results) {
          if (r.error) this.repoErrors[r.repo] = r.error;
          all.push(...r.runs);
        }
        all.sort((a, b) => Date.parse(b.startedAt ?? 0) - Date.parse(a.startedAt ?? 0));
        this.runs = all;
        this.announce();
        // For the status item: counts and when this was read.
        setShared("swamp-runs.summary", {
          running: all.filter((r) => r.status === "running").length,
          failedToday: all.filter((r) => r.status === "failed" && Date.now() - Date.parse(r.startedAt) < 86400000).length,
          at: Date.now(),
        });
      } finally {
        this.loading = false;
        this.refreshing = false;
        cx.notify();
      }
    });
  }

  // A toast when a run fails while a copy is open (not for old failures).
  // The failures already seen are shared, so a docked copy and a window copy
  // never toast the same failure twice.
  announce() {
    const failedNow = this.runs.filter((r) => r.status === "failed");
    const seenList = shared(SEEN_KEY);
    if (!Array.isArray(seenList) || !this.known) {
      // First load: remember what has failed so far, toast nothing.
      const seen = new Set(Array.isArray(seenList) ? seenList : []);
      for (const r of failedNow) seen.add(r.key);
      setShared(SEEN_KEY, [...seen].slice(-500));
      this.known = true;
      return;
    }
    const seen = new Set(seenList);
    const failed = failedNow.filter((r) => !seen.has(r.key));
    if (failed.length) {
      for (const r of failed) seen.add(r.key);
      setShared(SEEN_KEY, [...seen].slice(-500));
      notify({
        title: failed.length === 1 ? `Swamp run failed: ${failed[0].title}` : `${failed.length} swamp runs failed`,
        body: failed.length === 1 ? failed[0].error ?? base(failed[0].repo) : failed.map((r) => r.title).join(", "),
        level: "error",
        action: { name: "mod.open", args: { name: "swamp-runs" } },
      });
    }
  }

  toggle(r, cx) {
    this.open = this.open === r.key ? null : r.key;
    // Method history has no error text; ask for it the first time.
    if (this.open && r.kind === "method" && r.status === "failed" && !this.details[r.key]) {
      this.details[r.key] = { loading: true };
      cx.spawn(async (cx) => {
        try {
          const d = await this.swampJson(r.repo, ["behavior", "history", "get", r.id]);
          this.details[r.key] = { error: d?.error?.message ?? "No error message recorded." };
        } catch (e) {
          this.details[r.key] = { error: `Could not read details: ${e?.message ?? e}` };
        }
        cx.notify();
      });
    }
    cx.notify();
  }

  // Logs and reports open in one shared tab, "swamp logs", in the repo, where
  // they can scroll. Each click clears it and shows the new output there.
  openTab(r, what, cx) {
    const s = this.swamp;
    const argv = {
      logs: r.kind === "workflow" ? [s, "workflow", "history", "logs", r.id] : [s, "behavior", "history", "logs", r.id],
      report: r.kind === "workflow"
        ? [s, "report", "get", "@swamp/workflow-summary", "--workflow", r.workflowName]
        : [s, "report", "get", "@swamp/method-summary", "--behavior", r.modelName],
    }[what];
    const label = r.kind === "workflow" ? r.workflowName : r.modelName;
    cx.spawn(async (cx) => {
      try {
        const how = await runInTab(LOG_TAB, r.repo, argv, true);
        if (how === "busy") notify({ title: "The swamp logs tab is busy", body: `Wait for it to end, or stop it there (Ctrl-C or q), then open the ${what} of ${label} again.`, level: "info" });
      } catch (e) {
        notify({ title: `Could not open the ${what} of ${label}`, body: String(e?.message ?? e), level: "error" });
      }
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const COLOR = { succeeded: t.ansi2, failed: t.blocked, running: t.working, suspended: t.accent, cancelled: t.dim };
    const LABEL = { succeeded: "succeeded", failed: "failed", running: "running", suspended: "suspended", cancelled: "cancelled" };
    const many = new Set(this.runs.map((r) => r.repo)).size > 1 || Object.keys(this.repoErrors).length > 0;

    const shown = this.runs
      .filter((r) => this.filter === "all" || r.kind === this.filter)
      .filter((r) => !this.failedOnly || r.status === "failed")
      .slice(0, LIMIT);
    const running = this.runs.filter((r) => r.status === "running").length;
    const failed24 = this.runs.filter((r) => r.status === "failed" && Date.now() - Date.parse(r.startedAt) < 86400000).length;

    const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    const chip = (id, label, on, onClick) =>
      stop(h_flex().id(id).h(24).px(10).items_center().rounded(12).text_size(12).cursor_pointer()
        .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.chrome)
        .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).on_click(onClick).child(label));
    const button = (id, label, onClick) =>
      stop(h_flex().id(id).h(26).px(10).items_center().rounded(6).border_1().border_color(t.input).bg(t.surface)
        .text_color(t.foreground).text_size(12).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick).child(label));

    const row = (r) => {
      const open = this.open === r.key;
      const color = COLOR[r.status] ?? t.unknown;
      const det = this.details[r.key];
      const meta = [
        r.kind === "workflow" ? "workflow" : r.sub,
        r.kind === "workflow" && r.steps ? `steps ${r.steps.completed}/${r.steps.total}` : null,
        r.status === "running" ? null : dur(r.ms),
        r.kind === "workflow" ? r.sub : null,
        many ? base(r.repo) : null,
      ].filter(Boolean).join(" · ");
      const inputs = r.inputs && Object.keys(r.inputs).length
        ? Object.entries(r.inputs).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join("  ")
        : null;

      return v_flex().id(r.key).px(10).py(8).gap(4).rounded(8).cursor_pointer()
        .bg(open ? t.background : t.chrome).border_1().border_color(open ? t.border : t.chrome)
        .hover((s) => s.bg(open ? t.background : t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.toggle(r, cx))
        .child(h_flex().gap(8).items_center()
          .child(r.status === "running"
            ? div().w(10).flex_none().text_size(12).text_color(color).frames(SPIN, 90)
            : div().size(8).mx(1).rounded(4).flex_none().bg(color))
          .child(div().flex_1().truncate().text_size(13).text_color(t.foreground).child(r.title))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(r.startedAt))))
        .child(div().pl(18).truncate().text_size(11).text_color(t.muted).child(meta))
        .when(r.status === "failed" && !open && Boolean(r.error), (el) =>
          el.child(div().pl(18).truncate().text_size(11).text_color(t.blocked).child(r.failedStep ? `${r.failedStep}: ${r.error}` : r.error)))
        .when(open, (el) => el
          .child(v_flex().pl(18).pt(4).gap(4).text_size(11)
            .child(div().text_color(color).child(LABEL[r.status] ?? r.status))
            .when(Boolean(r.failedStep), (e) => e.child(div().text_color(t.muted).child(`Failed step: ${r.failedStep}`)))
            .when(Boolean(r.error), (e) => e.child(div().text_color(t.blocked).child(r.error)))
            .when(Boolean(det), (e) => e.child(det.loading
              ? div().text_color(t.muted).frames(SPIN.map((s) => `${s} Reading the error…`), 90)
              : div().text_color(t.blocked).child(det.error)))
            .when(Boolean(inputs), (e) => e.child(div().text_color(t.muted).child(inputs)))
            .child(div().text_color(t.dim).child(`run ${r.id} · ${short(r.repo)}`)))
          .child(h_flex().pt(4).gap(6).justify_end()
            .child(button(`${r.key}-logs`, "Logs", (_e, cx) => this.openTab(r, "logs", cx)))
            .when(Boolean(r.workflowName || r.modelName), (e) => e.child(button(`${r.key}-rep`, "Latest report", (_e, cx) => this.openTab(r, "report", cx))))));
    };

    const body = v_flex().gap(2);
    if (this.loading) body.child(div().py(20).text_size(12).text_color(t.muted).child("Reading swamp repos…"));
    else if (!shown.length) body.child(div().py(24).text_size(13).text_color(t.muted).child(this.failedOnly ? "No failed runs." : "No runs."));
    body.children(shown.map(row));
    for (const [repo, err] of Object.entries(this.repoErrors)) {
      body.child(div().mt(8).p(8).rounded(6).bg(t.raised).text_size(11).text_color(t.blocked).child(`${short(repo)}: ${err}`));
    }

    const hidden = this.runs.length > LIMIT && shown.length === LIMIT;

    return v_flex().id("root").size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(36).px(12).flex_none().items_center().gap(8).border_b_1().border_color(t.border)
        .child(div().flex_1().font_semibold().text_color(t.foreground).child("Swamp runs"))
        .when(running > 0, (el) => el.child(div().px(6).rounded(8).bg(t.working).text_color(t.background).text_size(11).child(`${running} running`)))
        .when(failed24 > 0, (el) => el.child(div().px(6).rounded(8).bg(t.blocked).text_color(t.background).text_size(11).child(`${failed24} failed today`)))
        .child(stop(div().id("refresh").px(6).py(2).rounded(4).text_size(11).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.refresh(cx)).child(this.refreshing ? "…" : "Refresh")))
        .when(Boolean(props()?.overlay), (el) => el.child(stop(div().id("close").px(6).py(2).rounded(4).text_size(13).text_color(t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => closeOverlay(props().overlay)).child("×")))))
      .child(h_flex().px(10).py(8).flex_none().gap(6).items_center()
        .child(chip("f-all", "All", this.filter === "all", (_e, cx) => { this.filter = "all"; cx.notify(); }))
        .child(chip("f-wf", "Workflows", this.filter === "workflow", (_e, cx) => { this.filter = "workflow"; cx.notify(); }))
        .child(chip("f-m", "Methods", this.filter === "method", (_e, cx) => { this.filter = "method"; cx.notify(); }))
        .child(div().flex_1())
        .child(chip("f-fail", "Failed only", this.failedOnly, (_e, cx) => { this.failedOnly = !this.failedOnly; cx.notify(); })))
      .child(div().id("scroll").flex_1().min_h(0).overflow_y_scrollbar().px(8).pb(10).child(body))
      .child(div().flex_none().px(12).py(4).text_size(10).text_color(t.dim)
        .child(hidden ? `Newest ${LIMIT} of ${this.runs.length} runs` : `${this.runs.length} runs`));
  }
}
