const limit = 4000;
const interval = 200;
const round = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined;

export function actorTrace(actor) {
  return {
    x: round(actor.x), y: round(actor.y), z: round(actor.z), hp: actor.hp, life: actor.life,
    gait: actor.gait, stance: actor.stance ?? (actor.crouch ? 'crouch' : 'stand'), state: actor.state,
    yaw: round(actor.yaw ?? Math.atan2(actor.facingX, actor.facingZ)), action: actor.action || undefined,
    swing: actor.attack?.id, warping: Boolean(actor.warping ?? actor.warp),
  };
}

export function createCombatRecorder(version, now = () => performance.now()) {
  const aliases = new Map();
  const marks = new Set();
  const present = new Set();
  const ring = [];
  let started, finished, active = false, count = 0, nextSample = 0, lastState;
  let startedAt, session = 0;

  const recorder = {
    get active() { return active; },
    get session() { return session; },
    get count() { return count; },
    peer(id) {
      if (!aliases.has(id)) aliases.set(id, 'player-' + (aliases.size + 1));
      return aliases.get(id);
    },
    start() {
      aliases.clear(); marks.clear(); present.clear(); ring.length = 0;
      count = nextSample = 0;
      lastState = finished = undefined;
      startedAt = new Date().toISOString();
      started = now();
      session++;
      active = true;
      recorder.log('recording.started');
    },
    stop() {
      if (!active) return;
      recorder.log('recording.stopped');
      finished = now();
      active = false;
    },
    log(event, data) {
      if (!active) return;
      ring[count++ % limit] = { ms: Math.round(now() - started), event, ...data };
    },
    once(key, event, data) {
      if (!active || marks.has(key)) return;
      if (marks.size >= limit) marks.delete(marks.values().next().value);
      marks.add(key);
      recorder.log(event, data);
    },
    sample(actor, input, players, character, connected) {
      if (!active) return;
      const state = [actor.gait, actor.stance, actor.state, actor.action, actor.hp, actor.life, character].join('|');
      if (state !== lastState) {
        recorder.log('actor.state', { actor: actorTrace(actor), character });
        lastState = state;
      }
      const time = now();
      if (time < nextSample) return;
      nextSample = time + interval;
      const others = [];
      for (const [id, pose] of players) {
        const player = recorder.peer(id);
        if (!present.has(player)) recorder.log('peer.joined', { player });
        const { swing, ...view } = actorTrace(pose);
        others.push({ player, ...view, swing, ageMs: round(time - pose.receivedAt) });
      }
      const current = new Set(others.map(({ player }) => player));
      for (const player of present) if (!current.has(player)) recorder.log('peer.left', { player });
      present.clear();
      for (const player of current) present.add(player);
      recorder.log('actor.sample', {
        actor: actorTrace(actor), character, connected, peers: others,
        input: { x: round(input.x), z: round(input.z), walk: input.walk, sprint: input.sprint,
          jump: input.jump, crouch: input.crouch, dash: input.dash },
      });
    },
    report() {
      const dropped = Math.max(0, count - limit);
      const start = dropped ? count % limit : 0;
      return { schema: 1, version, startedAt, durationMs: startedAt ? Math.round((finished ?? now()) - started) : 0,
        dropped, sampleIntervalMs: interval, events: [...ring.slice(start), ...ring.slice(0, start)] };
    },
  };
  return recorder;
}

export function mountCombatRecorder(section, signal, version) {
  const recorder = createCombatRecorder(version);
  const row = Object.assign(document.createElement('div'), { className: 'camera-buttons' });
  const toggle = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Record Troubleshoot' });
  const download = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Unduh Log JSON', disabled: true });
  const status = Object.assign(document.createElement('p'), { role: 'status' });
  toggle.setAttribute('aria-pressed', 'false');
  row.append(toggle, download);
  section.append(row, status);

  toggle.addEventListener('click', () => {
    if (recorder.active) {
      recorder.stop();
      toggle.textContent = 'Record Troubleshoot';
      status.textContent = 'Rekaman selesai · ' + recorder.count + ' event. Unduh log untuk diperiksa.';
    } else {
      recorder.start();
      toggle.textContent = 'Stop Troubleshoot';
      status.textContent = 'Sedang merekam. Tutup panel, ulangi masalahnya, lalu kembali untuk stop dan unduh log.';
    }
    toggle.setAttribute('aria-pressed', String(recorder.active));
    download.disabled = false;
  }, { signal });

  download.addEventListener('click', () => {
    const report = recorder.report();
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const file = Object.assign(document.createElement('a'), {
      href: url, download: 'mawa-troubleshoot-' + report.startedAt.replace(/[:.]/g, '-') + '.json',
    });
    section.append(file);
    file.click();
    file.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, { signal });
  signal.addEventListener('abort', () => recorder.stop(), { once: true });
  return recorder;
}
