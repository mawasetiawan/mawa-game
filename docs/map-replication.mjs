const SEND_INTERVAL = 80;
const HEARTBEAT_INTERVAL = 1000;

export function connectMapReplication(data, db, party, uid, signal, trace) {
  const { ref, push, set, remove, onValue, onDisconnect } = data;
  const positions = ref(db, 'partyRooms/' + party + '/positions');
  const players = new Map();
  const traffic = new Map();
  const attackListeners = new Set();
  let connectedRef = null;
  let lastSent = '';
  let lastAttackId;
  let lastHp;
  let nextUpdate = 0;

  const stopPositions = onValue(positions, snapshot => {
    const next = new Set();
    const now = performance.now();
    snapshot.forEach(player => {
      if (player.key === uid) return;
      const previousConnections = traffic.get(player.key) ?? new Map();
      const currentConnections = new Map();
      let latest;
      player.forEach(connection => {
        const value = connection.val();
        const signature = JSON.stringify(value);
        const previous = previousConnections.get(connection.key);
        const record = previous?.signature === signature ? previous : {
          ...value, connection: connection.key, signature, receivedAt: now,
        };
        currentConnections.set(connection.key, record);
        if (!latest || record.receivedAt >= latest.receivedAt) latest = record;
      });
      if (latest) {
        traffic.set(player.key, currentConnections);
        const previous = players.get(player.key);
        if (!previous || previous.connection !== latest.connection || previous.signature !== latest.signature) {
          const elapsed = previous?.connection === latest.connection ? latest.receivedAt - previous.receivedAt : Infinity;
          const velocity = axis => latest.life === previous?.life && !latest.warp && !previous?.warp &&
            elapsed >= 40 && elapsed <= 200 ?
            Math.max(-36, Math.min(36, (latest[axis] - previous[axis]) / (elapsed / 1000))) : 0;
          const pose = { ...latest, vx: velocity('x'), vz: velocity('z') };
          players.set(player.key, pose);
          if (latest.attack && latest.receivedAt === now) {
            if (trace?.active) trace.once('network:incoming:' + player.key + ':' + pose.connection + ':' + pose.attack.id,
              'network.attack_received', { player: trace.peer(player.key), swing: pose.attack.id, kind: pose.attack.kind });
            for (const listener of attackListeners) listener(player.key, pose, now);
          }
        }
        next.add(player.key);
      }
    });
    for (const id of players.keys()) {
      if (!next.has(id)) { players.delete(id); traffic.delete(id); }
    }
  }, error => {
    trace?.log('network.read_failed', { code: error.code });
    console.error('Map replication read:', error);
  });

  let connectionEpoch = 0;
  const stopConnected = onValue(ref(db, '.info/connected'), async snapshot => {
    const epoch = ++connectionEpoch;
    connectedRef = null;
    trace?.log('network.connection', { connected: snapshot.val() === true });
    if (snapshot.val() !== true || signal.aborted) return;
    const connection = push(ref(db, 'partyRooms/' + party + '/positions/' + uid));
    try {
      await onDisconnect(connection).remove();
      if (signal.aborted || epoch !== connectionEpoch) return;
      connectedRef = connection;
      lastSent = '';
      lastAttackId = undefined;
      lastHp = undefined;
      nextUpdate = 0;
    } catch (error) {
      trace?.log('network.setup_failed', { code: error.code });
      if (!signal.aborted && epoch === connectionEpoch) console.error('Map replication setup:', error);
    }
  });

  signal.addEventListener('abort', () => {
    stopConnected();
    stopPositions();
    players.clear();
    traffic.clear();
    attackListeners.clear();
    if (connectedRef) void remove(connectedRef).catch(error => console.error('Map replication cleanup:', error));
    connectedRef = null;
  }, { once: true });

  return {
    players,
    uid,
    connected: () => Boolean(connectedRef),
    onAttack(listener) { attackListeners.add(listener); },
    spawnAngle: [...uid].reduce((hash, letter) => Math.imul(hash ^ letter.charCodeAt(0), 16777619), 2166136261) >>> 0,
    publish(actor, now, character) {
      const attackId = actor.attack?.id;
      const startingHit = attackId !== undefined && attackId !== lastAttackId;
      if (!connectedRef && startingHit) trace?.once('offline:' + attackId, 'network.attack_unsent', { swing: attackId });
      const healthChanged = lastHp !== undefined && actor.hp !== lastHp;
      if (!connectedRef || (now < nextUpdate && !startingHit && !healthChanged)) return;
      const round = value => Math.round(value * 100) / 100;
      const pose = { x: round(actor.x), y: round(actor.y), z: round(actor.z), crouch: actor.stance === 'crouch',
        hp: actor.hp, life: actor.life, yaw: Math.atan2(actor.facingX, actor.facingZ),
        gait: actor.gait, state: actor.state };
      if (character?.id) pose.character = character.id;
      if (actor.action) {
        pose.action = actor.action;
        pose.anim = actor.actionSerial;
      }
      if (actor.warping) pose.warp = true;
      if (actor.impacts) pose.impacts = actor.impacts;
      if (actor.attack) pose.attack = actor.attack;
      pose.pulse = Math.floor(now / (actor.attack ? 120 : HEARTBEAT_INTERVAL)) % 1000000000;
      const key = JSON.stringify(pose);
      if (key === lastSent) return;
      const connection = connectedRef;
      lastSent = key;
      const previousHp = lastHp;
      lastHp = pose.hp;
      if (startingHit) lastAttackId = attackId;
      nextUpdate = now + SEND_INTERVAL;
      const tracePacket = trace?.active && Boolean(pose.attack);
      const traceSession = trace?.session;
      if (tracePacket) trace.log('network.attack_sent', { swing: attackId, kind: pose.attack.kind, x: pose.x, y: pose.y, z: pose.z });
      void set(connection, pose).then(() => {
        if (tracePacket && trace.session === traceSession && !signal.aborted) trace.log('network.attack_write_confirmed', { swing: attackId });
      }).catch(error => {
        if (connectedRef !== connection || signal.aborted) return;
        if (trace?.session === traceSession) trace?.log('network.write_failed', { swing: attackId, code: error.code });
        if (lastSent === key) {
          lastSent = '';
          lastHp = previousHp;
          if (startingHit && lastAttackId === attackId) lastAttackId = undefined;
        }
        console.error('Map replication write:', error);
      });
    }
  };
}
