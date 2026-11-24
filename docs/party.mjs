export function connectParty(data, db, user, profile, callbacks) {
  const { ref, push, update, onValue, serverTimestamp } = data;
  const uid = user.uid;
  const root = ref(db);
  let disposed = false;
  let stateReady = false;
  let invitesReady = false;
  let busy = false;
  let key = null;
  let room = null;
  let offers = {};
  let stopState, stopMembers, stopRequests, stopReply, timer;
  let hostMap, requestedRoom, acceptedRoom, requests = {};
  const requestPath = (roomId, playerId) => 'partyJoinRequests/' + roomId + '/' + playerId;
  const roster = {};
  const offerStates = new Map();
  const publish = () => {
    if (!disposed) callbacks.change({
      key, room, roster, requests, requestedRoom, ready: stateReady && invitesReady, busy,
      offers: Object.fromEntries(Object.entries(offers).filter(([id]) => offerStates.get(id)?.waiting))
    });
  };

  function switchRoom(next) {
    if (next === key && stateReady) return;
    stopState?.();
    stopMembers?.();
    stopRequests?.();
    hostMap = null;
    requests = {};
    key = next;
    const subscribed = next;
    room = null;
    for (const id of Object.keys(roster)) delete roster[id];
    stateReady = !next;
    if (next) {
      stopState = onValue(ref(db, 'partyRooms/' + next + '/state'), snapshot => {
        if (disposed || key !== subscribed) return;
        room = snapshot.val();
        const hosting = room?.host === uid && room.phase === 'playing' ? subscribed : null;
        if (hosting !== hostMap) {
          stopRequests?.();
          requests = {};
          hostMap = hosting;
          if (hostMap) stopRequests = onValue(ref(db, 'partyJoinRequests/' + hostMap), list => {
            if (disposed || hostMap !== hosting) return;
            requests = Object.fromEntries(Object.entries(list.val() ?? {}).filter(([, request]) =>
              request.status === 'pending' && Date.now() - request.at < 300_000));
            publish();
          }, callbacks.error);
        }
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
      if (acceptedRoom) queueMicrotask(completeJoin);
    }
  }

  function joinChanges(id) {
    return { ['partySeats/' + uid]: id, ['partyRooms/' + id + '/members/' + uid]: profile };
  }

  function clearRequest() {
    stopReply?.();
    stopReply = undefined;
    clearTimeout(timer);
    requestedRoom = acceptedRoom = null;
    publish();
  }

  async function cancelRequest(message) {
    const id = requestedRoom;
    if (!id) return;
    clearRequest();
    await update(root, { [requestPath(id, uid)]: null });
    if (!disposed) callbacks.notice(message);
  }

  async function completeJoin() {
    const id = acceptedRoom;
    if (!id || busy || disposed) return;
    clearRequest();
    try {
      await change(() => {
        if (key) throw Error('Keluar dari party sebelum masuk ke map lain.');
        return { ...joinChanges(id), [requestPath(id, uid)]: null };
      });
      if (!disposed) callbacks.notice('');
    } catch {
      if (!disposed) callbacks.notice('Map sudah ditutup atau permintaan masuk kedaluwarsa.');
    }
  }

  async function requestJoin(id) {
    if (key || busy || requestedRoom || disposed || !id) throw Error('Permintaan masuk sedang aktif.');
    const path = requestPath(id, uid);
    requestedRoom = id;
    try {
      await change(() => ({ [path]: { name: profile.name, status: 'pending', at: serverTimestamp() } }));
      if (disposed || requestedRoom !== id) return;
      timer = setTimeout(() => void cancelRequest('Permintaan masuk kedaluwarsa.').catch(callbacks.error), 300_000);
      stopReply = onValue(ref(db, path), snapshot => {
        if (disposed || requestedRoom !== id) return;
        const reply = snapshot.val()?.status;
        if (reply === 'accepted') {
          acceptedRoom = id;
          void completeJoin();
        } else if (reply === 'declined') void cancelRequest('Host menolak permintaan masuk.').catch(callbacks.error);
      }, callbacks.error);
    } catch (error) {
      clearRequest();
      throw error;
    }
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
    requestJoin,
    cancelRequest,
    answerRequest(target, accepted) {
      return change(() => {
        if (!hostMap || !requests[target]) throw Error('Permintaan sudah tidak tersedia.');
        return { [requestPath(hostMap, target) + '/status']: accepted ? 'accepted' : 'declined' };
      });
    },
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
      stopRequests?.();
      stopReply?.();
      clearTimeout(timer);
      for (const entry of offerStates.values()) entry.stop?.();
    }
  };
}
