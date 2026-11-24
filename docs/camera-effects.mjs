import { ActorState } from './movement.mjs?v=2';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sources = ['speed', 'vy', 'airborne', 'crouching'];
const limits = { yaw: [-180, 180], pitch: [-85, 85], distance: [.25, 4], smoothing: [0, 2] };
export const cameraExtension = {
  space: ['world', 'local', 'facing', 'velocity'],
  triggers: ['onJump', 'onLand', 'onImpact', 'crossAbove', 'crossBelow'],
  sources,
  limits,
  easing: ['linear', 'smooth', 'step', 'easeIn', 'easeOut', 'easeInOut', 'smootherstep'],
};

export function easeCamera(t, curve) {
  switch (curve) {
    case 'step': return 0;
    case 'smooth': return t * t * (3 - 2 * t);
    case 'smootherstep': return t ** 3 * (t * (6 * t - 15) + 10);
    case 'easeIn': return t ** 3;
    case 'easeOut': return 1 - (1 - t) ** 3;
    case 'easeInOut': return t < .5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    default: return t;
  }
}

function number(value, min, max, label) {
  if (!Number.isFinite(value) || value < min || value > max) throw Error(label + ' di luar batas.');
  return value;
}

function list(value, max, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw Error(label + ' tidak valid.');
  return value;
}

export function parseCameraEffects(data) {
  const space = data.space ?? 'world';
  if (!cameraExtension.space.includes(space)) throw Error('Ruang kamera tidak valid.');
  const blend = Object.fromEntries(Object.entries({ enter: .25, exit: .25, input: .10, state: .15 })
    .map(([key, fallback]) => [key, number(data.blend?.[key] ?? fallback, 0, 3, 'blend.' + key)]));
  const bindings = list(data.bindings, 12, 'bindings').map(entry => {
    if (!sources.includes(entry?.source) || !Object.hasOwn(limits, entry?.target)) throw Error('Binding tidak valid.');
    const low = number(entry.min, -100, 100, 'min');
    const high = number(entry.max, -100, 100, 'max');
    if (high <= low) throw Error('Binding memerlukan max lebih besar dari min.');
    const [min, max] = limits[entry.target];
    return { source: entry.source, target: entry.target, min: low, max: high,
      from: number(entry.from, min, max, 'from'), to: number(entry.to, min, max, 'to') };
  });
  const triggers = list(data.triggers, 16, 'triggers').map(entry => {
    const event = entry?.event;
    if (!cameraExtension.triggers.includes(event) || (!entry.shake && !entry.transition)) throw Error('Trigger tidak valid.');
    const result = { event };
    if (entry.shake) {
      const { amplitude, frequency, duration, decay } = entry.shake;
      result.shake = {
        amplitude: number(amplitude, 0, 3, 'amplitude'),
        frequency: number(frequency, 1, 45, 'frequency'),
        duration: number(duration, .02, 4, 'duration'),
        decay: number(decay ?? 2, 0, 8, 'decay'),
      };
    }
    if (entry.transition) {
      const { target, value, duration, easing = 'easeInOut' } = entry.transition;
      if (!Object.hasOwn(limits, target) || !cameraExtension.easing.includes(easing)) throw Error('Transition tidak valid.');
      result.transition = { target, easing, value: number(value, ...limits[target], 'value'),
        duration: number(duration, .02, 4, 'duration') };
    }
    if (event === 'crossAbove' || event === 'crossBelow') {
      if (!sources.includes(entry.source)) throw Error('Sumber ambang tidak valid.');
      result.source = entry.source;
      result.threshold = number(entry.threshold, -100, 100, 'threshold');
    }
    return result;
  });
  return { space, blend, bindings, triggers };
}

export function createCameraEffects(script) {
  const active = [];
  const neutral = { yaw: 0, pitch: 0, distance: 1, smoothing: null };
  const mods = { ...neutral };
  let previous;
  let velocityYaw;
  let heading;
  const output = { yaw: 0, mods: { ...neutral }, shake: [0,0,0] };
  return {
    update(actor, speedX, speedZ, dt, impact) {
      const airborne = actor.state !== undefined && actor.state !== ActorState.GROUNDED ? 1 : 0;
      const next = { speed: Math.hypot(speedX, speedZ), vy: actor.verticalSpeed ?? 0, airborne,
        crouching: actor.stance === 'crouch' ? 1 : 0 };
      for (const trigger of script.triggers) {
        const { event, source, threshold } = trigger;
        const fire = event === 'onImpact' ? impact : previous && (
          (event === 'onJump' && !previous.airborne && airborne && next.vy > 0) ||
          (event === 'onLand' && previous.airborne && !airborne) ||
          (event === 'crossAbove' && previous[source] < threshold && next[source] >= threshold) ||
          (event === 'crossBelow' && previous[source] > threshold && next[source] <= threshold)
        );
        if (fire) {
          if (active.length === 16) active.shift();
          active.push({ age: 0, shake: trigger.shake, transition: trigger.transition });
        }
      }
      const mix = script.blend.state ? 1 - Math.exp(-dt / script.blend.state) : 1;
      for (const binding of script.bindings) {
        const { source, target, min, max, from, to } = binding;
        const value = from + (to - from) * clamp((next[source] - min) / (max - min), 0, 1);
        mods[target] = mods[target] === null ? value : mods[target] + (value - mods[target]) * mix;
      }
      const facing = Math.atan2(-(actor.facingX ?? 0), -(actor.facingZ ?? -1));
      if (next.speed > .12) velocityYaw = Math.atan2(-speedX,-speedZ);
      const angle = script.space === 'velocity' ? velocityYaw ?? facing : script.space === 'world' ? 0 : facing;
      const diff = heading === undefined ? 0 : angle - heading;
      heading = heading === undefined ? angle : heading + Math.atan2(Math.sin(diff), Math.cos(diff)) * mix;
      output.yaw = heading;
      output.shake.fill(0);
      Object.assign(output.mods, mods);
      for (let i = 0; i < active.length; i++) {
        const impulse = active[i];
        const { age, shake, transition } = impulse;
        if (age >= Math.max(shake?.duration ?? 0, transition?.duration ?? 0)) {
          active.splice(i--,1);
          continue;
        }
        if (shake && age < shake.duration) {
          const t = age / shake.duration;
          const envelope = (1 - t) * Math.exp(-shake.decay * t) * shake.amplitude;
          const wave = 2 * Math.PI * shake.frequency * age;
          for (let axis = 0; axis < 3; axis++) {
            output.shake[axis] += Math.sin(wave * (1 - axis * .19)) * envelope;
          }
        }
        if (transition && age < transition.duration) {
          const t = age / transition.duration;
          const weight = easeCamera(1 - Math.abs(2 * t - 1), transition.easing);
          const from = output.mods[transition.target] ?? script.smoothing ?? .12;
          output.mods[transition.target] = from + (transition.value - from) * weight;
        }
        impulse.age += dt;
      }
      for (let i = 0; i < 3; i++) output.shake[i] = clamp(output.shake[i], -3, 3);
      previous = next;
      return output;
    },
  };
}
