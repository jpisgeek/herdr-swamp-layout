// Swamp quick run: pick a workflow in a watched swamp repo, fill its inputs
// (pre-filled from its last run, else from the schema defaults), confirm the
// exact command, and run it in a new tab in that repo.
//
// Nothing runs without the second click on "Confirm run". The run itself is
// a normal `swamp workflow run` in a terminal tab: its output, its approval
// gates and Ctrl-C all work as when you type it.
//
// Watched repos: REPOS below, props.repos (if a layout gives it), and the
// folder of any open space on this machine that has a .swamp.yaml.
//
// swamp sources (checked on swamp 20261102):
// - `swamp workflow search --json` -> results[]: name, description, hasInputs, trigger.schedule
// - `swamp workflow get <name> --json` -> inputs: JSON schema (properties, required)
// - `swamp workflow history search --json` -> results[]: last run status and inputs
// - `swamp workflow run <name> --input '<json object>'` takes every input at once

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { closeOverlay, exec, hc, home, panes, props, readTextFile, run, spaces, theme } from "herdr";

const REPOS = []; // extra swamp repos, e.g. ["~/git/my-swamp-repo"]; open spaces with a .swamp.yaml are added automatically

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

// Each workflow runs in its own tab, "run <workflow>", used again for every start.
const runTab = (name) => `run ${name}`;

const firstLine = (s) => (s ?? "").split("\n")[0];

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!isFinite(s)) return "";
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const i = text.indexOf("{");
    return i >= 0 ? JSON.parse(text.slice(i)) : null;
  }
}

const norm = (s) => (s === "completed" ? "succeeded" : s ?? "unknown");

// A value as the person types it: arrays as "a, b", objects as JSON.
function toText(v, type) {
  if (v == null) return "";
  if (type === "array") return Array.isArray(v) && v.every((x) => typeof x === "string" && !x.includes(",")) ? v.join(", ") : JSON.stringify(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// The typed text back to a value. Returns { value } or { error }; an empty
// field gives { empty: true } so the input is left out.
function fromText(text, spec) {
  const s = text.trim();
  if (!s) return { empty: true };
  const type = spec.type;
  try {
    if (type === "integer") {
      if (!/^-?\d+$/.test(s)) return { error: "must be a whole number" };
      return { value: parseInt(s, 10) };
    }
    if (type === "number") {
      const n = Number(s);
      return isFinite(n) ? { value: n } : { error: "must be a number" };
    }
    if (type === "boolean") {
      if (s === "true" || s === "false") return { value: s === "true" };
      return { error: "must be true or false" };
    }
    if (type === "array") {
      const arr = s.startsWith("[") ? JSON.parse(s) : s.split(",").map((x) => x.trim()).filter(Boolean);
      if (!Array.isArray(arr)) return { error: "must be a list" };
      const it = spec.items?.type;
      const vals = it === "integer" || it === "number" ? arr.map(Number) : arr;
      if (spec.minItems && vals.length < spec.minItems) return { error: `needs at least ${spec.minItems} item${spec.minItems > 1 ? "s" : ""}` };
      return { value: vals };
    }
    if (type === "object") return { value: JSON.parse(s) };
    if (spec.enum && !spec.enum.includes(s)) return { error: `must be one of: ${spec.enum.join(", ")}` };
    return { value: s };
  } catch {
    return { error: "is not valid JSON" };
  }
}

// Quote a word for display only (the tab gets argv, not a shell line).
const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export default class SwampQuickRun extends View {
  init(_props, cx) {
    this.swamp = "swamp";
    this.flows = []; // { repo, name, description, schedule, hasInputs, last }
    this.repoErrors = {};
    this.loading = true;
    this.sel = null; // the chosen workflow
    this.schema = null; // its inputs schema
    this.schemaError = null;
    this.fields = {}; // name -> InputState
    this.errors = {}; // name -> message
    this.source = null; // "last run" | "defaults"
    this.confirm = false;
    this.started = null; // name of the last workflow started, for a short note
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
    if (r.code !== 0 && (!data || data.error)) throw new Error(data?.error ?? ((r.stderr || r.stdout).trim().split("\n").pop() || `exit ${r.code}`));
    return data;
  }

  async loadRepo(repo) {
    const [list, hist] = await Promise.all([
      this.swampJson(repo, ["workflow", "search"]),
      this.swampJson(repo, ["workflow", "history", "search"]).catch(() => ({ results: [] })),
    ]);
    // The newest run of each workflow (history is not always sorted).
    const last = {};
    for (const r of hist?.results ?? []) {
      const prev = last[r.workflowName];
      if (!prev || Date.parse(r.startedAt) > Date.parse(prev.startedAt)) last[r.workflowName] = r;
    }
    return (list?.results ?? []).map((w) => ({
      repo, key: `${repo}#${w.name}`, name: w.name, description: w.description ?? "",
      schedule: w.trigger?.schedule ?? null, hasInputs: w.hasInputs, last: last[w.name] ?? null,
    }));
  }

  refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.swampChecked) await this.findSwamp();
        const repos = await this.repoList();
        const results = await Promise.all(repos.map((repo) =>
          this.loadRepo(repo).then((flows) => ({ repo, flows }), (e) => ({ repo, flows: [], error: String(e?.message ?? e) }))));
        this.repoErrors = {};
        const all = [];
        for (const r of results) {
          if (r.error) this.repoErrors[r.repo] = r.error;
          all.push(...r.flows);
        }
        // Most recently run first; never-run ones after, by name.
        all.sort((a, b) => (Date.parse(b.last?.startedAt ?? 0) || 0) - (Date.parse(a.last?.startedAt ?? 0) || 0) || a.name.localeCompare(b.name));
        this.flows = all;
      } finally {
        this.loading = false;
        this.refreshing = false;
        cx.notify();
      }
    });
  }

  pick(w, cx) {
    this.sel = w;
    this.schema = null;
    this.schemaError = null;
    this.fields = {};
    this.errors = {};
    this.confirm = false;
    this.started = null;
    this.startError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const d = await this.swampJson(w.repo, ["workflow", "get", w.name]);
        if (this.sel !== w) return;
        this.schema = d?.inputs ?? { properties: {} };
        this.fill(cx, "last");
      } catch (e) {
        if (this.sel === w) this.schemaError = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  // Fill each field from the last run's inputs, or from the schema defaults.
  fill(cx, from) {
    const props_ = this.schema?.properties ?? {};
    const lastInputs = this.sel?.last?.inputs ?? null;
    const useLast = from === "last" && lastInputs && Object.keys(lastInputs).length > 0;
    this.source = useLast ? "last" : "defaults";
    for (const [name, spec] of Object.entries(props_)) {
      const v = useLast && name in lastInputs ? lastInputs[name] : spec.default;
      const text = toText(v, spec.type);
      if (this.fields[name]) this.fields[name].set_value(text);
      else {
        const st = InputState.new({ placeholder: this.placeholder(spec), value: text });
        st.on("change", (_e, cx) => {
          this.confirm = false;
          if (this.errors[name]) delete this.errors[name];
          cx.notify();
        });
        this.fields[name] = st;
      }
    }
    this.errors = {};
    this.confirm = false;
  }

  placeholder(spec) {
    if (spec.type === "array") return "values, separated by commas";
    if (spec.type === "integer" || spec.type === "number") return "a number";
    if (spec.type === "boolean") return "true or false";
    if (spec.type === "object") return "JSON object";
    if (spec.enum) return spec.enum.join(" | ");
    return "";
  }

  // The inputs object, or null when a field is wrong (this.errors says why).
  collect() {
    const props_ = this.schema?.properties ?? {};
    const required = new Set(this.schema?.required ?? []);
    const out = {};
    this.errors = {};
    for (const [name, spec] of Object.entries(props_)) {
      const r = fromText(this.fields[name]?.value() ?? "", spec);
      if (r.error) this.errors[name] = r.error;
      else if (r.empty) {
        if (required.has(name)) this.errors[name] = "is required";
      } else out[name] = r.value;
    }
    return Object.keys(this.errors).length ? null : out;
  }

  argv(inputs) {
    const a = [this.swamp, "workflow", "run", this.sel.name];
    if (Object.keys(inputs).length) a.push("--input", JSON.stringify(inputs));
    return a;
  }

  start(cx) {
    this.startError = null;
    const inputs = this.collect();
    if (!inputs) {
      this.confirm = false;
      cx.notify();
      return;
    }
    if (!this.confirm) {
      this.confirm = true;
      this.pendingArgv = this.argv(inputs);
      cx.notify();
      return;
    }
    const w = this.sel;
    const argv = this.argv(inputs);
    this.confirm = false;
    cx.spawn(async (cx) => {
      try {
        const how = await runInTab(runTab(w.name), w.repo, argv, false);
        // "busy": the footer already shows that it still runs, with Show tab.
        if (how !== "busy") this.started = w.name;
      } catch (e) {
        this.startError = `Could not start: ${String(e?.message ?? e)}`;
      }
      cx.notify();
      // Show the new run as "last run" in the list a moment later.
      cx.timer.after(4000, (cx) => this.refresh(cx));
    });
  }

  render(cx) {
    const t = theme();
    const COLOR = { succeeded: t.ansi2, failed: t.blocked, running: t.working, suspended: t.accent, cancelled: t.dim };
    const many = new Set(this.flows.map((w) => w.repo)).size > 1 || Object.keys(this.repoErrors).length > 0;
    const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    const button = (id, label, onClick, kind) =>
      stop(h_flex().id(id).h(28).px(12).items_center().rounded(6).text_size(12).cursor_pointer()
        .border_1()
        .border_color(kind === "solid" ? t.solid : kind === "warn" ? t.blocked : t.input)
        .bg(kind === "solid" ? t.solid : kind === "warn" ? t.blocked : t.surface)
        .text_color(kind === "solid" ? t.solid_foreground : kind === "warn" ? t.background : t.foreground)
        .hover((s) => s.border_color(t.accent)).on_click(onClick).child(label));
    const link = (id, label, onClick) =>
      stop(div().id(id).px(6).py(2).rounded(4).text_size(11).text_color(t.muted).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click(onClick).child(label));

    const lastLine = (w) => {
      if (!w.last) return div().text_size(11).text_color(t.dim).child("never run");
      const st = norm(w.last.status);
      return h_flex().gap(6).items_center().text_size(11).text_color(t.muted)
        .child(div().size(7).rounded(4).flex_none().bg(COLOR[st] ?? t.unknown))
        .child(`last ${st} ${ago(w.last.startedAt)}`);
    };

    // ---- list of workflows ----
    const listView = () => {
      const body = v_flex().gap(2);
      if (this.loading) body.child(div().py(20).text_size(12).text_color(t.muted).child("Reading swamp repos…"));
      else if (!this.flows.length) body.child(div().py(24).text_size(13).text_color(t.muted).child("No workflows."));
      body.children(this.flows.map((w) =>
        stop(v_flex().id(w.key).px(10).py(8).gap(3).rounded(8).cursor_pointer().bg(t.chrome)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(w, cx))
          .child(h_flex().gap(8).items_center()
            .child(div().flex_1().truncate().text_size(13).text_color(t.foreground).child(w.name))
            .when(Boolean(w.schedule), (el) => el.child(div().flex_none().px(6).rounded(8).bg(t.raised).text_size(10).text_color(t.muted).child(`⏱ ${w.schedule}`)))
            .when(many, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(base(w.repo)))))
          .child(div().truncate().text_size(11).text_color(t.muted).child(firstLine(w.description)))
          .child(lastLine(w)))));
      for (const [repo, err] of Object.entries(this.repoErrors)) {
        body.child(div().mt(8).p(8).rounded(6).bg(t.raised).text_size(11).text_color(t.blocked).child(`${short(repo)}: ${err}`));
      }
      return body;
    };

    // ---- one workflow: inputs and run ----
    const formView = () => {
      const w = this.sel;
      const body = v_flex().gap(10).px(4).pt(4);
      body.child(v_flex().gap(4)
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child(w.name))
        .child(div().text_size(11).text_color(t.dim).child(short(w.repo)))
        .child(div().text_size(12).text_color(t.muted).child(w.description))
        .child(lastLine(w)));

      if (this.schemaError) {
        body.child(div().p(8).rounded(6).bg(t.raised).text_size(11).text_color(t.blocked).child(`Could not read the inputs: ${this.schemaError}`));
        return body;
      }
      if (!this.schema) {
        body.child(div().text_size(12).text_color(t.muted).child("Reading the inputs…"));
        return body;
      }

      const entries = Object.entries(this.schema.properties ?? {});
      const required = new Set(this.schema.required ?? []);
      if (!entries.length) body.child(div().text_size(12).text_color(t.muted).child("This workflow has no inputs."));
      else {
        body.child(h_flex().items_center().gap(6).pt(4).border_t_1().border_color(t.border)
          .child(div().flex_1().pt(6).text_size(11).text_color(t.dim)
            .child(this.source === "last" ? "Filled from the last run" : "Filled from the defaults"))
          .when(this.source === "last", (el) => el.child(link("use-def", "Use defaults", (_e, cx) => { this.fill(cx, "defaults"); cx.notify(); })))
          .when(this.source !== "last" && Boolean(w.last?.inputs && Object.keys(w.last.inputs).length), (el) =>
            el.child(link("use-last", "Use last run", (_e, cx) => { this.fill(cx, "last"); cx.notify(); }))));
        for (const [name, spec] of entries) {
          const err = this.errors[name];
          body.child(v_flex().gap(3)
            .child(h_flex().gap(4).items_center()
              .child(div().text_size(12).font_semibold().text_color(t.foreground).child(name))
              .when(required.has(name), (el) => el.child(div().text_size(12).text_color(t.blocked).child("*")))
              .child(div().text_size(10).text_color(t.dim).child(spec.type === "array" ? `list of ${spec.items?.type ?? "values"}` : spec.type ?? "")))
            .child(stop(div().id(`in-${name}`).h(28).px(8).flex().items_center().rounded(6).border_1()
              .border_color(err ? t.blocked : t.input).bg(t.background).text_size(12).text_color(t.foreground)
              .child(Input.new(this.fields[name]))))
            .when(Boolean(err), (el) => el.child(div().text_size(11).text_color(t.blocked).child(`${name} ${err}`)))
            .when(Boolean(spec.description), (el) => el.child(div().text_size(11).text_color(t.muted).child(spec.description))));
        }
      }

      if (this.started) body.child(div().text_size(12).text_color(t.ansi2).child(`Started ${this.started} in its tab.`));
      return body;
    };

    const inForm = Boolean(this.sel);
    const canRun = inForm && Boolean(this.schema) && !this.schemaError;
    const openTab = inForm ? findTab(runTab(this.sel.name)) : null;
    const busyTab = openTab?.busy ? openTab : null;

    return v_flex().id("root").size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(36).px(12).flex_none().items_center().gap(8).border_b_1().border_color(t.border)
        .when(inForm, (el) => el.child(link("back", "‹ Workflows", (_e, cx) => { this.sel = null; this.confirm = false; cx.notify(); })))
        .child(div().flex_1().font_semibold().text_color(t.foreground).child(inForm ? "" : "Swamp quick run"))
        .when(!inForm, (el) => el.child(link("refresh", this.refreshing ? "…" : "Refresh", (_e, cx) => this.refresh(cx))))
        .when(Boolean(props()?.overlay), (el) => el.child(stop(div().id("close").px(6).py(2).rounded(4).text_size(13).text_color(t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => closeOverlay(props().overlay)).child("×")))))
      .child(div().id("scroll").flex_1().min_h(0).overflow_y_scrollbar().px(8).py(8).child(inForm ? formView() : listView()))
      .when(canRun, (el) => el.child(v_flex().flex_none().px(12).py(10).gap(8).border_t_1().border_color(t.border)
        // The exact command, shown next to the button that runs it.
        .when(this.confirm, (e) => e.child(v_flex().gap(4).p(8).rounded(6).bg(t.raised).border_1().border_color(t.blocked)
          .child(div().text_size(12).text_color(t.foreground).child(`This runs in a new tab in ${short(this.sel.repo)}:`))
          .child(div().text_size(11).text_color(t.foreground).child(this.pendingArgv.map((a, i) => (i === 0 ? "swamp" : q(a))).join(" ")))))
        .when(Object.keys(this.errors).length > 0, (e) => e.child(div().text_size(11).text_color(t.blocked).child("Correct the inputs marked in red.")))
        // "Run in new tab" is at the right edge; "Confirm run" goes to the left edge and Cancel
        // takes the right edge, so a double-click never lands on Confirm run.
        .when(Boolean(busyTab), (e) => e.child(h_flex().gap(8).items_center()
          .child(div().flex_1().text_size(11).text_color(t.working).child(`${this.sel.name} still runs in its tab. Start it again when it ends.`))
          .child(button("show-tab", "Show tab", () => showTab(busyTab)))))
        .when(Boolean(this.startError), (e) => e.child(div().text_size(11).text_color(t.blocked).child(this.startError)))
        .when(!busyTab, (e) => e.child(this.confirm
          ? h_flex().gap(8).items_center().justify_between()
              .child(button("confirm-run", "Confirm run", (_e, cx) => this.start(cx), "warn"))
              .child(button("cancel", "Cancel", (_e, cx) => { this.confirm = false; cx.notify(); }))
          : h_flex().gap(8).items_center().justify_end()
              .child(button("run", openTab ? "Run in its tab" : "Run in new tab", (_e, cx) => this.start(cx), "solid"))))));
  }
}
