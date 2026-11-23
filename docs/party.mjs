export function connectParty(data, db, user, profile, callbacks) {
  const { ref, push, update, onValue } = data;
  const uid = user.uid;
  const root = ref(db);
  let disposed = false;
  let stateReady = false;
  let invitesReady = false;
  let busy = false;
  let key = null;
  let room = null;
  let offers = {};
  let stopState, stopMembers;
  const roster = {};
  const offerStates = new Map();
  const publish = () => {
    if (!disposed) callbacks.change({
      key, room, roster, ready: stateReady && invitesReady, busy,
      offers: Object.fromEntries(Object.entries(offers).filter(([id]) => offerStates.get(id)?.waiting))
    });
  };

  function switchRoom(next) {
    if (next === key && stateReady) return;
    stopState?.();
    stopMembers?.();
    key = next;
    const subscribed = next;
    room = null;
    for (const id of Object.keys(roster)) delete roster[id];
    stateReady = !next;
    if (next) {
      stopState = onValue(ref(db, 'partyRooms/' + next + '/state'), snapshot => {
        if (disposed || key !== subscribed) return;
        room = snapshot.val();
        stateReady = true;
        publish();
        if (room?.phase === 'closed' && !busy) void leave(false).catch(callbacks.error);
      }, error => { if (key === subscribed && !disposed) callbacks.error(error); });
      stopMembers = onValue(ref(db, 'partyRooms/' + next + '/members'), snapshot => {
        if (disposed || key !== subscribed) return;
        for (const id of Object.keys(roster)) delete roster[id];
        Object.assign(roster, snapshot.val() || {});
        publish();
      }, error => { if (key === subscribed && !disposed) callbacks.error(error); });
    }
    publish();
  }

  const stopSeat = onValue(ref(db, 'partySeats/' + uid), snapshot => switchRoom(snapshot.val()), callbacks.error);
  const stopInvites = onValue(ref(db, 'partyInvites/' + uid), snapshot => {
    offers = snapshot.val() || {};
    for (const [id, entry] of offerStates) {
      if (offers[id]) continue;
      entry.stop?.();
      offerStates.delete(id);
    }
    for (const id of Object.keys(offers)) {
      if (offerStates.has(id)) continue;
      const entry = { waiting: false };
      offerStates.set(id, entry);
      entry.stop = onValue(ref(db, 'partyRooms/' + id + '/state'), state => {
        entry.waiting = state.val()?.phase === 'waiting';
        publish();
      }, () => {
        entry.waiting = false;
        publish();
      });
    }
    invitesReady = true;
    publish();
  }, callbacks.error);

  async function change(makeChanges) {
    if (busy || disposed) throw new Error('Party sedang diperbarui');
    busy = true;
    publish();
    try { await update(root, makeChanges()); }
    finally {
      busy = false;
      publish();
    }
  }

  function joinChanges(id) {
    return { ['partySeats/' + uid]: id, ['partyRooms/' + id + '/members/' + uid]: profile };
  }

  function exitChanges(closeHost) {
    if (!key) return {};
    const changes = { ['partySeats/' + uid]: null, ['partyRooms/' + key + '/members/' + uid]: null };
    if (closeHost && room?.host === uid && room.phase !== 'closed') {
      changes['partyRooms/' + key + '/state/phase'] = 'closed';
    }
    return changes;
  }

  function createChanges(next) {
    return { ...joinChanges(next), ['partyRooms/' + next + '/state']: { host: uid, name: profile.name, phase: 'waiting' } };
  }

  function leave(closeHost = true) {
    if (!key || busy) return Promise.resolve();
    return change(() => exitChanges(closeHost));
  }

  return {
    create() {
      return change(() => {
        if (key) throw new Error('Sudah berada di party');
        return createChanges(push(ref(db, 'partyRooms')).key);
      });
    },
    invite(target) {
      return change(() => {
        if (key && (room?.host !== uid || room.phase !== 'waiting')) throw new Error('Hanya host lobby dapat mengundang');
        const id = key || push(ref(db, 'partyRooms')).key;
        return {
          ...(key ? {} : createChanges(id)),
          ['partyInvites/' + target + '/' + id]: { from: uid, name: profile.name }
        };
      });
    },
    accept(id) {
      return change(() => {
        if (!offers[id] || key === id) throw new Error('Undangan sudah tidak tersedia');
        if (key && (room?.host !== uid || room.phase !== 'waiting' || Object.keys(roster).some(member => member !== uid))) {
          throw new Error('Keluar dari party saat ini terlebih dahulu');
        }
        return { ...exitChanges(true), ...joinChanges(id), ['partyInvites/' + uid + '/' + id]: null };
      });
    },
    decline(id) { return change(() => ({ ['partyInvites/' + uid + '/' + id]: null })); },
    begin() {
      return change(() => {
        if (!key || room?.host !== uid || room.phase !== 'waiting') throw new Error('Hanya host dapat memulai');
        return { ['partyRooms/' + key + '/state/phase']: 'playing' };
      });
    },
    leave,
    dispose() {
      disposed = true;
      stopSeat();
      stopInvites();
      stopState?.();
      stopMembers?.();
      for (const entry of offerStates.values()) entry.stop?.();
    }
  };
}
