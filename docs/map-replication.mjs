const SEND_INTERVAL = 80;

export function connectMapReplication(data, db, party, uid, signal) {
  const { ref, push, set, remove, onValue, onDisconnect } = data;
  const positions = ref(db, 'partyRooms/' + party + '/positions');
  const players = new Map();
  let connectedRef = null;
  let lastSent = '';
  let nextUpdate = 0;

  const stopPositions = onValue(positions, snapshot => {
    const next = new Set();
    snapshot.forEach(player => {
      if (player.key === uid) return;
      let latest;
      player.forEach(connection => { latest = connection.val(); });
      if (latest) {
        players.set(player.key, latest);
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
    spawnAngle: [...uid].reduce((hash, letter) => Math.imul(hash ^ letter.charCodeAt(0), 16777619), 2166136261) >>> 0,
    publish(actor, now) {
      if (!connectedRef || now < nextUpdate) return;
      const round = value => Math.round(value * 100) / 100;
      const pose = { x: round(actor.x), y: round(actor.y), z: round(actor.z), crouch: actor.stance === 'crouch' };
      const key = JSON.stringify(pose);
      if (key === lastSent) return;
      const connection = connectedRef;
      lastSent = key;
      nextUpdate = now + SEND_INTERVAL;
      void set(connection, pose).catch(error => {
        if (connectedRef !== connection || signal.aborted) return;
        console.error('Map replication write:', error);
      });
    }
  };
}
