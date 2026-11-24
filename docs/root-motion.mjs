const prepared = new WeakMap();

export function rootMotionOptions(settings) {
  return {
    enabled: settings?.enabled === true,
    node: typeof settings?.node === 'string' ? settings.node.slice(0, 100) : '',
  };
}

export function horizontalRootMotion(THREE, asset, clip) {
  if (!asset.rootMotion?.enabled || !clip) return null;
  let clips = prepared.get(asset);
  if (!clips) prepared.set(asset, clips = new WeakMap());
  const requested = asset.rootMotion.node;
  const cached = clips.get(clip);
  if (cached?.requested === requested) return cached.motion;
  const motion = extract(THREE, asset, clip, requested);
  clips.set(clip, { requested, motion });
  return motion;
}

function extract(THREE, asset, clip, requested) {
  const index = clip.tracks.findIndex(track => {
    if (track.ValueTypeName !== 'vector' || !track.name.endsWith('.position')) return false;
    const binding = THREE.PropertyBinding.parseTrackName(track.name);
    const name = binding.objectName === 'bones' ? binding.objectIndex : binding.nodeName;
    return requested ? name === requested : /(?:^|[:_])(root|rootmotion|motionroot|armature)$/i.test(name ?? '');
  });
  if (index < 0) return null;
  const source = clip.tracks[index];
  const binding = THREE.PropertyBinding.parseTrackName(source.name);
  const name = binding.objectName === 'bones' ? binding.objectIndex : binding.nodeName;
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
