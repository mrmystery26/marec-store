"use strict";
// The download manager the window uses. The launcher core downloads one game per call and can stop
// a download without losing the verified parts, so:
//   Pause  = stop now, keep the parts already verified; Resume continues from the last good part.
//   Cancel = stop and forget this entry (the parts already verified are reused if you install again).
// Queueing is done here: at most `limit` games download at once (1 by default, kind to slow links).
(function (host) {
  const dep = (name) => (typeof require === "function" ? require(`./${name}`) : host.MarecUI[name]);
  const { unwrap } = dep("data");

  function createDownloads({ api, now = Date.now, onChange = () => {}, onDone = () => {}, limit = 1 }) {
    const active = new Map(); // gameId -> running download
    const queue = []; // [{item, update}]
    const paused = new Map(); // gameId -> {item, update, done, total}
    let maxActive = limit;

    const idOf = (item) => item.game_id;
    const isBusy = (id) => active.has(id) || paused.has(id) || queue.some((q) => idOf(q.item) === id);

    async function start({ item, update }) {
      const id = idOf(item);
      const t = now();
      const run = { item, update, done: 0, total: 0, startedAt: t, lastAt: t, lastDone: 0, speed: 0, stop: null };
      active.set(id, run);
      let status = "failed";
      let version = null;
      let pending = false;
      let error = null;
      try {
        const result = await unwrap(api.install(id));
        status = "completed";
        version = result.version;
        pending = Boolean(result.pending);
      } catch (e) {
        if (e.code === "CANCELLED") status = run.stop === "pause" ? "paused" : "cancelled";
        else error = e;
      } finally {
        active.delete(id);
      }
      if (status === "paused") paused.set(id, { item, update, done: run.done, total: run.total });
      pump();
      onChange();
      onDone({ item, update, status, version, pending, error, bytes: run.total });
    }

    function pump() {
      while (active.size < maxActive && queue.length) start(queue.shift());
    }

    return {
      isBusy,
      count: () => active.size + queue.length + paused.size,
      statusOf(id) {
        if (active.has(id)) return "downloading";
        if (paused.has(id)) return "paused";
        if (queue.some((q) => idOf(q.item) === id)) return "queued";
        return null;
      },

      enqueue(item, { update = false } = {}) {
        if (isBusy(idOf(item))) return false;
        queue.push({ item, update });
        pump();
        onChange();
        return true;
      },
      pause(id) {
        const run = active.get(id);
        if (!run) return;
        run.stop = "pause";
        api.cancel(id);
      },
      resume(id) {
        const entry = paused.get(id);
        if (!entry) return;
        paused.delete(id);
        queue.unshift({ item: entry.item, update: entry.update });
        pump();
        onChange();
      },
      cancel(id) {
        const run = active.get(id);
        if (run) {
          run.stop = "cancel";
          api.cancel(id);
          return;
        }
        paused.delete(id);
        const at = queue.findIndex((q) => idOf(q.item) === id);
        if (at >= 0) queue.splice(at, 1);
        onChange();
      },
      setLimit(n) {
        maxActive = Math.max(1, Math.min(3, Number(n) || 1));
        pump();
        onChange();
      },

      /** Called with each progress event from the launcher: {gameId, done, total}. */
      handleProgress({ gameId, done, total }) {
        const run = active.get(gameId);
        if (!run) return false;
        const t = now();
        const seconds = (t - run.lastAt) / 1000;
        if (seconds >= 0.5) {
          const instant = Math.max(0, (done - run.lastDone) / seconds);
          run.speed = run.speed ? run.speed * 0.7 + instant * 0.3 : instant;
          run.lastAt = t;
          run.lastDone = done;
        }
        run.done = done;
        run.total = total;
        return true;
      },

      /** What to show for one game, or null when it is not in the manager. */
      progress(id) {
        const run = active.get(id) || paused.get(id);
        if (!run) return null;
        const percent = run.total ? Math.min(100, Math.floor((run.done / run.total) * 100)) : 0;
        const speed = run.speed || 0;
        const eta = speed > 0 && run.total > run.done ? (run.total - run.done) / speed : 0;
        return { done: run.done, total: run.total, percent, speed, eta };
      },

      list: () => ({
        active: [...active.values()].map((r) => ({ item: r.item, update: r.update })),
        queued: queue.map((q) => ({ item: q.item, update: q.update })),
        paused: [...paused.values()].map((p) => ({ item: p.item, update: p.update })),
      }),
    };
  }

  const api = { createDownloads };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (host.MarecUI = host.MarecUI || {}).downloads = api;
})(typeof window !== "undefined" ? window : globalThis);
