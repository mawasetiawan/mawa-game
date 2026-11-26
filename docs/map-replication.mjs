const SEND_INTERVAL = 80;

export function connectMapReplication(data, db, party, uid, signal) {
  const { ref, push, set, remove, onValue, onDisconnect } = data;
  const positions = ref(db, 'partyRooms/' + party + '/positions');
  const players = new Map();
  let connectedRef = null;
  let lastSent = '';
  let lastAttackId;
  let nextUpdate = 0;

  const stopPositions = onValue(positions, snapshot => {
    const next = new Set();
    snapshot.forEach(player => {
      if (player.key === uid) return;
      let latest;
      player.forEach(connection => { latest = { ...connection.val(), connection: connection.key }; });
      if (latest) {
        const previous = players.get(player.key);
        const signature = JSON.stringify(latest);
        if (previous?.signature !== signature) {
          const now = performance.now();
          const elapsed = previous ? now - previous.receivedAt : Infinity;
          const velocity = axis => latest.life === previous?.life && !latest.warp && !previous?.warp &&
            elapsed >= 40 && elapsed <= 200 ?
            Math.max(-36, Math.min(36, (latest[axis] - previous[axis]) / (elapsed / 1000))) : 0;
          players.set(player.key, { ...latest, signature, receivedAt: now, vx: velocity('x'), vz: velocity('z') });
        }
        next.add(player.key);
      }
    });
    for (const id of players.keys()) {
      if (!next.has(id)) players.delete(id);
    }
  }, error => console.error('Map replication read:', error));

  let connectionEpoch = 0;
  const stopConnected = onValue(ref(db, '.info/connected'), async snapshot => {
    const epoch = ++connectionEpoch;
    connectedRef = null;
    if (snapshot.val() !== true || signal.aborted) return;
    const connection = push(ref(db, 'partyRooms/' + party + '/positions/' + uid));
    try {
      await onDisconnect(connection).remove();
      if (signal.aborted || epoch !== connectionEpoch) return;
      connectedRef = connection;
      lastSent = '';
      lastAttackId = undefined;
      nextUpdate = 0;
    } catch (error) {
      if (!signal.aborted && epoch === connectionEpoch) console.error('Map replication setup:', error);
    }
  });

  signal.addEventListener('abort', () => {
    stopConnected();
    stopPositions();
    players.clear();
    if (connectedRef) void remove(connectedRef).catch(error => console.error('Map replication cleanup:', error));
    connectedRef = null;
  }, { once: true });

  return {
    players,
    uid,
    spawnAngle: [...uid].reduce((hash, letter) => Math.imul(hash ^ letter.charCodeAt(0), 16777619), 2166136261) >>> 0,
    publish(actor, now, character) {
      const attackId = actor.attack?.id;
      const startingHit = attackId !== undefined && attackId !== lastAttackId;
      if (!connectedRef || (now < nextUpdate && !startingHit)) return;
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
      if (actor.attack) {
        pose.attack = actor.attack;
        pose.pulse = Math.floor(now / 120) % 1000000000;
      }
      const key = JSON.stringify(pose);
      if (key === lastSent) return;
      const connection = connectedRef;
      lastSent = key;
      if (startingHit) lastAttackId = attackId;
      nextUpdate = now + SEND_INTERVAL;
      void set(connection, pose).catch(error => {
        if (connectedRef !== connection || signal.aborted) return;
        if (lastSent === key) {
          lastSent = '';
          if (startingHit && lastAttackId === attackId) lastAttackId = undefined;
        }
        console.error('Map replication write:', error);
      });
    }
  };
}
