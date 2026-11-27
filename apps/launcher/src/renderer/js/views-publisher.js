"use strict";
// The publisher portal: kept apart from the storefront. A signed-in player confirms their email,
// accepts the developer rules and creates a developer account (with a first studio). Once MAREC has
// verified the studio they can create demos, fill in their details, upload a build (from a PC),
// download the SDK file for the game, and submit it for review.
(function (host) {
  const STATUS_TEXT = {
    pending: "Waiting for MAREC to verify this studio", verified: "Verified", suspended: "Suspended",
    draft: "Draft", submitted: "Submitted", under_review: "In review", changes_requested: "Changes requested",
    approved: "Approved", scheduled: "Scheduled", published: "Published", removed: "Removed",
    uploading: "Uploading", processing: "Checking files", ready: "Ready", failed: "Failed", revoked: "Revoked",
  };
  const statusKind = (s) => (["verified", "published", "approved", "ready"].includes(s) ? "ok"
    : ["suspended", "removed", "changes_requested", "failed", "revoked"].includes(s) ? "bad" : "warn");
  const EDITABLE = new Set(["draft", "changes_requested"]);
  const AGE_RATINGS = ["3+", "7+", "12+", "16+", "18+"];

  // Plain-language rules shown before a developer account is created. The version is sent to the
  // store, which refuses an out-of-date version, so changing these means changing TERMS_VERSION there.
  const RULES = [
    "You made the game, or you have the right to share every file you upload. Do not upload other people's work.",
    "Your files must be safe: no viruses, malware or anything that harms a player's computer or data.",
    "For now MAREC only accepts free demos. Every demo is reviewed by MAREC before it appears in the store.",
    "Be honest in the description, the age rating and the system requirements. Players rely on them.",
    "MAREC can ask you to make changes, and can suspend or remove a demo that breaks these rules.",
    "Your studio name and your demo's details are shown publicly in the store.",
  ];

  const mb = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

  function validateStudioName(value) {
    const name = String(value || "").split(/\s+/).filter(Boolean).join(" ");
    if (name.length < 2 || name.length > 60) return { error: "Use 2 to 60 characters for the studio name." };
    return { name };
  }

  /** The game form's fields -> the changes the store expects, or what is wrong. */
  function validateDetails(f) {
    const errors = {};
    const summary = String(f.summary || "").trim();
    const description = String(f.description || "").trim();
    if (!summary) errors.summary = "Write a one-line summary.";
    else if (summary.length > 280) errors.summary = "Keep the summary to 280 characters or fewer.";
    if (!description) errors.description = "Describe your game.";
    else if (description.length > 10000) errors.description = "Keep the description to 10,000 characters or fewer.";
    if (!AGE_RATINGS.includes(f.age)) errors.age = "Choose an age rating.";
    if (!f.categories.length) errors.categories = "Pick at least one genre (up to 5).";
    else if (f.categories.length > 5) errors.categories = "Pick at most 5 genres.";
    const ram = Number(f.ram);
    const storage = Number(f.storage);
    if (!String(f.os || "").trim()) errors.os = "Say which Windows version is needed.";
    if (!String(f.cpu || "").trim()) errors.cpu = "Say which processor is needed.";
    if (!Number.isInteger(ram) || ram < 256 || ram > 262144) errors.ram = "Enter the memory in MB (at least 256).";
    if (!Number.isInteger(storage) || storage < 1 || storage > 2_000_000) errors.storage = "Enter the disk space in MB.";
    if (Object.keys(errors).length) return { errors };
    return {
      errors,
      changes: {
        summary, description, age_rating: f.age, category_slugs: f.categories,
        requirements: [{ tier: "minimum", os: f.os.trim(), cpu: f.cpu.trim(), ram_mb: ram, gpu: String(f.gpu || "").trim(), storage_mb: storage }],
      },
    };
  }

  const formFrom = (g) => {
    const min = (g.requirements || []).find((r) => r.tier === "minimum") || {};
    return {
      id: g.id, summary: g.summary || "", description: g.description || "", age: g.age_rating || "",
      categories: (g.categories || []).map((cat) => cat.slug),
      os: min.os || "Windows 10 64-bit", cpu: min.cpu || "", ram: String(min.ram_mb || 4096), gpu: min.gpu || "", storage: String(min.storage_mb || 500),
      errors: {},
    };
  };

  // ------------------------------------------------------------------ becoming a developer
  function onboarding(ctx, info) {
    const { h, c, button } = ctx;
    const p = ctx.state.publisher;
    const input = h("input", { value: p.studioName, maxlength: "60", placeholder: "Studio name", "aria-label": "Studio name", oninput: (e) => { p.studioName = e.target.value; } });
    const create = async () => {
      p.studioName = input.value;
      const result = validateStudioName(p.studioName);
      if (result.error) { p.error = result.error; return ctx.rerender(); }
      if (!p.accepted) { p.error = "Accept the developer rules to continue."; return ctx.rerender(); }
      p.busy = true; p.error = ""; ctx.rerender();
      try {
        await ctx.actions.dev.register(result.name, info.terms_version);
        p.studioName = ""; p.accepted = false;
        ctx.invalidate("developer");
        ctx.toast("Developer account created. MAREC will verify your studio.", "info");
      } catch (error) {
        p.error = error.message;
      }
      p.busy = false;
      ctx.rerender();
    };
    return h("div", {},
      c.sectionHead("Become a developer", "Publish free demos of your game on MAREC Store."),
      h("ol", { class: "steps" },
        h("li", {}, info.email_verified ? "Your email address is confirmed." : "Confirm your email address."),
        h("li", {}, "Accept the developer rules and name your studio."),
        h("li", {}, "MAREC verifies your studio. You get an email."),
        h("li", {}, "Create a demo, upload it, and send it for review.")),
      info.email_verified ? null : ctx.emailCard(),
      h("section", { class: "block narrow" }, c.sectionHead("Developer rules", `Version ${info.terms_version}`),
        h("ul", { class: "rules" }, RULES.map((rule) => h("li", {}, rule))),
        c.toggle({ label: "I accept the developer rules", checked: p.accepted, onchange: (v) => { p.accepted = v; p.error = ""; ctx.rerender(); } }),
        c.field({ label: "Studio name", hint: "This is the name players see on your demos.", input }),
        p.error ? c.notice("warn", p.error) : null,
        button({ label: p.busy ? "Creating…" : "Create developer account", kind: "primary", disabled: p.busy || !info.email_verified, onclick: create })));
  }

  // ------------------------------------------------------------------ the developer home
  function studioBlock(ctx, info, studio) {
    const { h, c, button } = ctx;
    const p = ctx.state.publisher;
    const verified = studio.status === "verified";
    const res = ctx.resource(`developer:games:${studio.id}`, () => ctx.actions.dev.games(studio.id));
    let games;
    if (res.status === "loading") games = h("div", { class: "bone wide" });
    else if (res.status === "error") {
      games = c.errorState({ title: "Could not load your demos", message: res.error.message, actions: [button({ label: "Try again", onclick: () => { ctx.invalidate("developer:games:"); ctx.rerender(); } })] });
    } else if (!res.data.items.length) {
      games = c.emptyState({ icon: "box", title: "No demos yet", body: verified ? "Create your first demo below." : "You can create demos once MAREC has verified this studio." });
    } else {
      games = h("div", { class: "table-wrap" }, h("table", { class: "specs wide" },
        h("thead", {}, h("tr", {}, h("th", {}, "Demo"), h("th", {}, "Status"), h("th", {}, "Updated"), h("th", {}, ""))),
        h("tbody", {}, res.data.items.map((g) =>
          h("tr", {}, h("td", {}, g.title),
            h("td", {}, h("span", { class: `status ${statusKind(g.status)}` }, STATUS_TEXT[g.status] || g.status)),
            h("td", {}, ctx.fmt.formatDate(g.updated_at)),
            h("td", {}, button({ label: "Open", onclick: () => { p.gameId = g.id; p.form = null; p.upload = null; p.error = ""; ctx.rerender(); } })))))));
    }

    const titleInput = h("input", { value: p.newTitle, maxlength: "80", placeholder: "Demo title", "aria-label": "Demo title", oninput: (e) => { p.newTitle = e.target.value; } });
    const make = async () => {
      p.newTitle = titleInput.value;
      const title = String(p.newTitle || "").split(/\s+/).filter(Boolean).join(" ");
      if (title.length < 2) { p.error = "Use at least 2 characters for the title."; return ctx.rerender(); }
      p.busy = true; p.error = ""; ctx.rerender();
      try {
        const created = await ctx.actions.dev.createGame(studio.id, title);
        p.newTitle = "";
        ctx.invalidate("developer:games:");
        p.gameId = created.id; p.form = null; p.upload = null;
      } catch (error) {
        p.error = error.message;
      }
      p.busy = false;
      ctx.rerender();
    };

    return h("section", { class: "block" },
      c.sectionHead(studio.name, `Your role: ${studio.my_role}`, h("span", { class: `status ${statusKind(studio.status)}` }, STATUS_TEXT[studio.status] || studio.status)),
      verified ? null : c.notice("info", studio.status === "pending"
        ? "MAREC has to verify this studio before you can upload. You will get an email when it is done."
        : "This studio cannot publish right now."),
      games,
      verified ? h("div", { class: "panel-form" },
        c.field({ label: "New demo", hint: `Free demos only for now: up to ${info.limits.max_games_per_studio} per studio.`, input: titleInput }),
        button({ label: p.busy ? "Creating…" : "Create demo", kind: "primary", disabled: p.busy, onclick: make })) : null);
  }

  function home(ctx, info) {
    const { h, c } = ctx;
    const p = ctx.state.publisher;
    return h("div", {},
      info.limits.demo_only ? c.notice("info", `Demos only for now: every demo is free, at most ${info.limits.max_demo_build_mb} MB, and reviewed by MAREC before it is shown in the store.`) : null,
      p.error && !p.gameId ? c.notice("warn", p.error) : null,
      info.studios.map((studio) => studioBlock(ctx, info, studio)));
  }

  // ------------------------------------------------------------------ one demo: details, builds, submit
  function detailsForm(ctx, game, editable) {
    const { h, c, button } = ctx;
    const p = ctx.state.publisher;
    if (!p.form || p.form.id !== game.id) p.form = formFrom(game);
    const f = p.form;
    const cats = ctx.resource("categories", () => ctx.data.categories());
    // The fields are read when Save is pressed (not only while typing), so pasted and autofilled
    // text is never missed.
    const refs = {};
    const sync = () => { for (const [key, el] of Object.entries(refs)) f[key] = el.value; };
    const text = (key, props) => (refs[key] = h("input", { value: f[key], disabled: !editable, "aria-label": props.label, ...props.attrs, oninput: (e) => { f[key] = e.target.value; } }));
    const area = (key, label, rows) => (refs[key] = h("textarea", { value: f[key], rows: String(rows), disabled: !editable, "aria-label": label, oninput: (e) => { f[key] = e.target.value; } }));
    const age = c.select({ ariaLabel: "Age rating", value: f.age, disabled: !editable, options: [{ value: "", label: "Choose…" }, ...AGE_RATINGS.map((a) => ({ value: a, label: a }))], onchange: (v) => { f.age = v; } });
    const genres = h("div", { class: "chips" }, (cats.status === "ready" ? cats.data : []).map((cat) => {
      const on = f.categories.includes(cat.slug);
      return h("button", { type: "button", class: `chip ${on ? "on" : ""}`.trim(), "aria-pressed": String(on), disabled: !editable,
        onclick: () => { sync(); f.categories = on ? f.categories.filter((s) => s !== cat.slug) : [...f.categories, cat.slug]; ctx.rerender(); } }, cat.name);
    }));
    const save = async () => {
      sync();
      const result = validateDetails(f);
      f.errors = result.errors;
      if (!result.changes) return ctx.rerender();
      p.busy = true; p.error = ""; ctx.rerender();
      try {
        await ctx.actions.dev.updateGame(game.id, result.changes);
        ctx.invalidate("developer:game");
        ctx.invalidate("developer:games:");
        p.form = null;
        ctx.toast("Details saved.", "info");
      } catch (error) {
        p.error = error.message;
      }
      p.busy = false;
      ctx.rerender();
    };
    return h("section", { class: "block" },
      c.sectionHead("Details", editable ? "What players see on the demo's page." : "You can change details again if MAREC asks for changes."),
      c.field({ label: "Summary", error: f.errors.summary, hint: "One line, up to 280 characters.", input: text("summary", { label: "Summary", attrs: { maxlength: "280" } }) }),
      c.field({ label: "Description", error: f.errors.description, input: area("description", "Description", 6) }),
      c.field({ label: "Age rating", error: f.errors.age, input: age }),
      c.field({ label: "Genres", error: f.errors.categories, hint: "Pick up to 5.", input: genres }),
      h("h4", {}, "Minimum system requirements"),
      c.field({ label: "Windows version", error: f.errors.os, input: text("os", { label: "Windows version", attrs: { maxlength: "80" } }) }),
      c.field({ label: "Processor", error: f.errors.cpu, input: text("cpu", { label: "Processor", attrs: { maxlength: "120", placeholder: "For example Intel Core i3" } }) }),
      c.field({ label: "Memory (MB)", error: f.errors.ram, input: text("ram", { label: "Memory in MB", attrs: { inputmode: "numeric" } }) }),
      c.field({ label: "Graphics card (optional)", input: text("gpu", { label: "Graphics card", attrs: { maxlength: "120" } }) }),
      c.field({ label: "Disk space (MB)", error: f.errors.storage, input: text("storage", { label: "Disk space in MB", attrs: { inputmode: "numeric" } }) }),
      editable ? button({ label: p.busy ? "Saving…" : "Save details", kind: "primary", disabled: p.busy, onclick: save }) : null);
  }

  function buildsSection(ctx, info, game, studioVerified, editable) {
    const { h, c, button } = ctx;
    const p = ctx.state.publisher;
    const res = ctx.resource(`developer:builds:${game.id}`, () => ctx.actions.dev.builds(game.id));
    let list;
    if (res.status === "loading") list = h("div", { class: "bone wide" });
    else if (res.status === "error") list = c.errorState({ title: "Could not load builds", message: res.error.message });
    else if (!res.data.length) list = c.emptyState({ icon: "upload", title: "No build yet", body: "Upload your game's Windows export to continue." });
    else {
      list = h("div", { class: "table-wrap" }, h("table", { class: "specs wide" },
        h("thead", {}, h("tr", {}, h("th", {}, "Version"), h("th", {}, "Status"), h("th", {}, "Files"), h("th", {}, "Size"), h("th", {}, "Uploaded"))),
        h("tbody", {}, res.data.map((b) =>
          h("tr", {}, h("td", {}, b.version), h("td", {}, h("span", { class: `status ${statusKind(b.status)}` }, STATUS_TEXT[b.status] || b.status)),
            h("td", {}, String(b.file_count)), h("td", {}, mb(b.total_size_bytes)), h("td", {}, ctx.fmt.formatDate(b.created_at)))))));
    }

    let uploader;
    if (ctx.platform.mobile) {
      uploader = c.notice("info", "Builds are folders of a Windows game. Upload them with the MAREC Store launcher on a PC.");
    } else if (!studioVerified) {
      uploader = c.notice("info", "You can upload as soon as MAREC has verified your studio.");
    } else if (!editable) {
      uploader = c.notice("info", "This demo is with MAREC for review, so it cannot get a new build right now.");
    } else {
      uploader = uploadPanel(ctx, info, game);
    }
    return h("section", { class: "block" }, c.sectionHead("Builds", "The exported Windows game that players download."), list, uploader);
  }

  function uploadPanel(ctx, info, game) {
    const { h, c, button } = ctx;
    const p = ctx.state.publisher;
    const u = (p.upload ||= { folder: null, version: "1.0.0", notes: "", entry: "", running: false, error: "", problems: [], nodes: null });
    const rerender = () => ctx.rerender();

    const choose = async () => {
      u.error = ""; u.problems = [];
      try {
        const folder = await ctx.actions.dev.pickBuildFolder();
        if (folder) { u.folder = folder; u.entry = folder.exeCandidates.length === 1 ? folder.exeCandidates[0] : ""; }
      } catch (error) {
        u.error = error.message;
      }
      rerender();
    };

    const fill = h("div");
    const label = h("div", { class: "meta" });
    u.nodes = { fill, label };
    const onProgress = (e) => {
      if (e.gameId !== game.id || !u.nodes) return;
      const pct = e.total ? Math.min(100, Math.floor((e.done / e.total) * 100)) : 0;
      u.nodes.fill.style.width = `${pct}%`;
      const what = e.phase === "hashing" ? "Checking files" : e.phase === "uploading" ? "Uploading" : "Finishing";
      u.nodes.label.textContent = `${what}… ${pct}% (${mb(e.done)} of ${mb(e.total)})`;
    };

    const start = async () => {
      u.version = versionInput.value;
      u.notes = notesInput.value;
      if (!u.folder) { u.error = "Choose the game folder first."; return rerender(); }
      if (!String(u.version).trim()) { u.error = "Enter a version, for example 1.0.0."; return rerender(); }
      if (!u.entry) { u.error = "Choose which .exe starts the game."; return rerender(); }
      u.running = true; u.error = ""; u.problems = [];
      rerender();
      const stop = ctx.actions.dev.onUploadProgress(onProgress);
      try {
        await ctx.actions.dev.uploadBuild({ gameId: game.id, version: String(u.version).trim(), notes: String(u.notes).trim() || undefined, entryPoint: u.entry });
        p.upload = null;
        ctx.invalidate("developer:builds:");
        ctx.invalidate("developer:game");
        ctx.toast("Build uploaded and checked.", "info");
      } catch (error) {
        u.error = error.message;
        u.running = false;
      } finally {
        if (typeof stop === "function") stop();
      }
      rerender();
    };

    const versionInput = h("input", { value: u.version, maxlength: "32", disabled: u.running, "aria-label": "Version", oninput: (e) => { u.version = e.target.value; } });
    const notesInput = h("textarea", { value: u.notes, rows: "3", disabled: u.running, "aria-label": "Release notes", oninput: (e) => { u.notes = e.target.value; } });
    const folder = u.folder;
    const exe = folder && folder.exeCandidates.length
      ? c.select({ ariaLabel: "Start file", value: u.entry, options: [{ value: "", label: "Choose…" }, ...folder.exeCandidates.map((n) => ({ value: n, label: n }))], disabled: u.running, onchange: (v) => { u.entry = v; } })
      : null;
    return h("div", { class: "panel-form upload" },
      h("h4", {}, "Upload a build"),
      info.limits.demo_only ? h("p", { class: "muted small" }, `A demo can be at most ${info.limits.max_demo_build_mb} MB.`) : null,
      button({ label: folder ? "Choose a different folder" : "Choose game folder", icon: "folder", disabled: u.running, onclick: choose }),
      folder ? h("p", { class: "muted small" }, `${folder.name}: ${folder.fileCount} files, ${mb(folder.totalBytes)}`) : null,
      folder && !folder.exeCandidates.length ? c.notice("warn", "There is no .exe at the top of this folder. Export your game for Windows and choose that folder.") : null,
      exe ? c.field({ label: "File that starts the game", input: exe }) : null,
      c.field({ label: "Version", input: versionInput }),
      c.field({ label: "Release notes (optional)", input: notesInput }),
      u.running ? h("div", {}, h("div", { class: "bar" }, fill), label) : null,
      u.error ? c.notice("warn", u.error) : null,
      u.problems.length ? h("ul", { class: "rules" }, u.problems.map((x) => h("li", {}, x))) : null,
      h("div", { class: "row" },
        u.running
          ? button({ label: "Cancel upload", kind: "ghost", onclick: () => ctx.actions.dev.cancelUpload() })
          : button({ label: "Upload build", kind: "primary", disabled: !folder, onclick: start })));
  }

  function gameEditor(ctx, info, gameId) {
    const { h, c, button } = ctx;
    const p = ctx.state.publisher;
    const back = button({ label: "All demos", icon: "chevron-left", kind: "ghost", onclick: () => { p.gameId = null; p.form = null; p.upload = null; p.error = ""; ctx.rerender(); } });
    const res = ctx.resource(`developer:game:${gameId}`, () => ctx.actions.dev.game(gameId));
    if (res.status === "loading") return h("div", {}, back, h("div", { class: "bone wide" }));
    if (res.status === "error") return h("div", {}, back, c.errorState({ title: "This demo did not load", message: res.error.message, actions: [button({ label: "Try again", onclick: () => { ctx.invalidate("developer:game"); ctx.rerender(); } })] }));
    const game = res.data;
    const editable = EDITABLE.has(game.status);
    const studio = info.studios.find((s) => s.slug === (game.studio && game.studio.slug)) || info.studios.find((s) => s.name === (game.studio && game.studio.name));
    const studioVerified = Boolean(studio && studio.status === "verified");

    const submit = async () => {
      p.busy = true; p.error = ""; ctx.rerender();
      try {
        await ctx.actions.dev.submitGame(game.id);
        ctx.invalidate("developer:game");
        ctx.invalidate("developer:games:");
        ctx.toast("Sent for review. You will get an email with the decision.", "info");
      } catch (error) {
        p.error = error.message;
      }
      p.busy = false;
      ctx.rerender();
    };
    const sdk = async () => {
      try {
        const saved = await ctx.actions.dev.downloadSdkConfig(game.id);
        if (saved) ctx.toast("Saved marec_config.gd. Put it in addons/marec_sdk in your Godot project.", "info");
      } catch (error) {
        p.error = error.message;
        ctx.rerender();
      }
    };

    return h("div", {},
      back,
      c.sectionHead(game.title, game.release_kind === "demo" ? "Free demo" : "Game", h("span", { class: `status ${statusKind(game.status)}` }, STATUS_TEXT[game.status] || game.status)),
      game.status === "changes_requested" && game.status_reason ? c.notice("warn", `MAREC asked for changes: ${game.status_reason}`) : null,
      p.error ? c.notice("warn", p.error) : null,
      detailsForm(ctx, game, editable),
      buildsSection(ctx, info, game, studioVerified, editable),
      ctx.platform.mobile ? null : h("section", { class: "block" },
        c.sectionHead("Godot SDK", "Your game checks with the store that a player launched it properly."),
        h("p", { class: "muted small" }, "Download the file already filled in for this demo and replace addons/marec_sdk/marec_config.gd with it."),
        button({ label: "Download SDK config", icon: "download", onclick: sdk })),
      h("section", { class: "block" },
        c.sectionHead("Send for review", "MAREC checks every demo before players see it."),
        editable
          ? button({ label: p.busy ? "Sending…" : "Submit for review", kind: "primary", disabled: p.busy, onclick: submit })
          : h("p", { class: "muted" }, game.status === "published" ? "This demo is live in the store." : "This demo is with MAREC or already decided.")));
  }

  // ------------------------------------------------------------------ the page
  function publisher(ctx) {
    const { h, c, button } = ctx;
    const res = ctx.resource("developer:account", () => ctx.actions.dev.account());
    let body;
    if (res.status === "loading") body = h("div", { class: "bone wide", "aria-busy": "true" });
    else if (res.status === "error") {
      body = c.errorState({ title: "The publisher portal did not load", message: res.error.message, actions: [button({ label: "Try again", kind: "primary", onclick: () => { ctx.invalidate("developer"); ctx.rerender(); } })] });
    } else if (!res.data.is_developer) body = onboarding(ctx, res.data);
    else if (ctx.state.publisher.gameId) body = gameEditor(ctx, res.data, ctx.state.publisher.gameId);
    else body = home(ctx, res.data);
    return h("div", { class: "page publisher" },
      h("header", { class: "page-head" }, h("h1", {}, "Publisher portal"), h("p", { class: "muted" }, "Upload free demos of your games and send them for review.")),
      body);
  }

  const api = { publisher, validateStudioName, validateDetails, formFrom };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {})["views-publisher"] = api;
})(typeof window !== "undefined" ? window : globalThis);
