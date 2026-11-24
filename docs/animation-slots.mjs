export const combatActions = {
  basic: 'Basic Attack', skill1: 'Skill 1', skill2: 'Skill 2', ultimate: 'Ultimate',
};
export const comboLimit = 4;
export const attackSlot = (action, stage) => action + 'Combo' + stage;
const normalize = value => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const attackNames = {
  basic: ['basicattack', 'normalattack', 'lightattack', 'melee', 'punch', 'attack'],
  skill1: ['skill1', 'skillone', 'ability1'],
  skill2: ['skill2', 'skilltwo', 'ability2'],
  ultimate: ['ultimate', 'ultymate', 'ulti', 'skill3', 'ability3'],
};
const aliases = {
  crouchEnter: ['crouchenter', 'entercrouch', 'crouchstart', 'standtocrouch'],
  crouchExit: ['crouchexit', 'exitcrouch', 'crouchend', 'crouchtostand'],
  crouchIdle: ['crouchidle', 'idlecrouch', 'crouch', 'sneakidle'],
  crouchMove: ['crouchmove', 'movecrouch', 'crouchwalk', 'walkcrouch', 'sneakwalk'],
  death: ['death', 'dying', 'dead', 'die'], interact: ['interact', 'interaction', 'useobject'],
  land: ['land', 'landing', 'jumpend'], fall: ['falling', 'fallloop', 'fall', 'jumpfall'],
  jump: ['jumpstart', 'jump', 'leap'], dash: ['dash', 'dodge'],
  sprint: ['sprint', 'sprintforward', 'runfast'], walk: ['walk', 'walking'],
  run: ['run', 'running', 'jog'], idle: ['idle', 'rest', 'standidle', 'standing'],
};

function match(clipName) {
  const name = normalize(clipName);
  for (const [action, names] of Object.entries(attackNames)) {
    for (const alias of names) {
      if (action === 'basic' && Object.values(attackNames).slice(1).flat().some(other => name.includes(other))) continue;
      if (!name.includes(alias)) continue;
      const tail = name.slice(name.indexOf(alias) + alias.length);
      const stage = Number(name.match(/(?:combo|step|hit)([1-4])(?!\d)/)?.[1] ?? tail.match(/^0*([1-4])(?!\d)/)?.[1] ?? 1);
      return [attackSlot(action, stage), name === alias ? 3 : 2];
    }
  }
  let best;
  for (const [slot, names] of Object.entries(aliases)) {
    for (const alias of names) {
      if (!name.includes(alias)) continue;
      // Prefer specific compound names such as "Crouch Idle" and "Jump Landing".
      const score = (name === alias ? 100 : 0) + alias.length;
      if (!best || score > best[1]) best = [slot, score];
    }
  }
  return best;
}

export function detectAnimations(clips) {
  const scores = new Map();
  const mapping = {};
  clips.forEach((clip, index) => {
    const result = match(clip.name || '');
    if (!result) return;
    const [slot, score] = result;
    if (score <= (scores.get(slot) ?? 0)) return;
    scores.set(slot, score);
    mapping[slot] = String(index);
  });
  return mapping;
}

export const loopsByDefault = slot => ['idle', 'walk', 'run', 'sprint', 'crouchIdle', 'crouchMove', 'fall'].includes(slot);
