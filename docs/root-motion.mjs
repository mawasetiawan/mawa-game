const prepared = new WeakMap();

export function rootMotionOptions(settings) {
  return {
    enabled: settings?.enabled === true,
    node: typeof settings?.node === 'string' ? settings.node.slice(0, 100) : '',
    locomotion: settings?.locomotion === 'root' ? 'root' : 'in-place',
    useRootSpeed: settings?.useRootSpeed === true,
  };
}

export function horizontalRootMotion(THREE, asset, clip, allowHips = false) {
  if (!clip) return null;
  let clips = prepared.get(asset);
  if (!clips) prepared.set(asset, clips = new WeakMap());
  const requested = asset.rootMotion?.node ?? '';
  const cached = clips.get(clip);
  if (cached?.requested === requested && cached.allowHips === allowHips) return cached.motion;
  const preferred = /(?:^|[:_])(root|rootmotion|motionroot|armature)(?:_\d+)?$/i;
  const hips = /(?:hips|pelvis)(?:_\d+)?$/i;
  const tracks = clip.tracks.flatMap((track, index) => {
    if (track.ValueTypeName !== 'vector' || !track.name.endsWith('.position')) return [];
    const binding = THREE.PropertyBinding.parseTrackName(track.name);
    const name = binding.objectName === 'bones' ? binding.objectIndex : binding.nodeName;
    if (requested ? name === requested : preferred.test(name ?? '')) return [{ name, index, priority: 0 }];
    if (!requested && allowHips && hips.test(name ?? '')) return [{ name, index, priority: 1 }];
    return [];
  });
  tracks.sort((a, b) => a.priority - b.priority);
  let motion = null;
  for (const { name, index } of tracks) {
    motion = extract(THREE, asset, clip, name, index);
    if (motion) break;
  }
  clips.set(clip, { requested, allowHips, motion });
  return motion;
}

function extract(THREE, asset, clip, name, index) {
  const source = clip.tracks[index];
  const node = THREE.PropertyBinding.findNode(asset.scene, name);
  if (!node?.parent) return null;

  asset.fit.updateWorldMatrix(true, true);
  const basis = new THREE.Matrix3().setFromMatrix4(
    asset.fit.matrixWorld.clone().invert().multiply(node.parent.matrixWorld));
  if (Math.abs(basis.determinant()) < 1e-8) return null;
  const inverse = basis.clone().invert();
  const sample = source.createInterpolant();
  const base = new THREE.Vector3().fromArray(sample.evaluate(source.times[0]));
  const vector = new THREE.Vector3();
  const delta = (values, out) => out.fromArray(values).sub(base).applyMatrix3(basis);
  function offset(time) {
    const point = delta(sample.evaluate(time), vector);
    return { x: point.x, z: point.z };
  }
  let travels = false;
  for (const [i, time] of source.times.entries()) {
    const end = offset(time);
    const mid = i ? offset((time + source.times[i - 1]) / 2) : end;
    if (Math.hypot(end.x, end.z) > .001 || Math.hypot(mid.x, mid.z) > .001) {
      travels = true;
      break;
    }
  }
  if (!travels) return null;

  // Keep vertical movement and the starting root pose in the visual clip.
  const pose = clip.clone();
  pose.tracks[index].createInterpolant = buffer => {
    const interpolant = source.createInterpolant(buffer);
    const evaluate = interpolant.evaluate.bind(interpolant);
    const horizontal = new THREE.Vector3();
    interpolant.evaluate = time => {
      const values = evaluate(time);
      delta(values, horizontal);
      horizontal.y = 0;
      horizontal.applyMatrix3(inverse);
      values[0] -= horizontal.x;
      values[1] -= horizontal.y;
      values[2] -= horizontal.z;
      return values;
    };
    return interpolant;
  };
  return { pose, offset };
}

export function rootDelta(offset, duration, start, end, loop) {
  const cycle = loop ? Math.floor(end / duration) - Math.floor(start / duration) : 0;
  const from = offset(loop ? start % duration : Math.min(start, duration));
  const to = offset(loop ? end % duration : Math.min(end, duration));
  const stride = offset(duration);
  return { x: to.x - from.x + cycle * stride.x, z: to.z - from.z + cycle * stride.z };
}
