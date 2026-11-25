const prepared = new WeakMap();
const hipsName = /(?:hips|pelvis)(?:_\d+)?$/i;

export function createInPlaceLock(THREE, fit, scene) {
  const carriers = new Set([scene]);
  const hips = new Set();
  const meshes = [];
  const rest = new Map();
  function addChain(node, throughHip = false) {
    for (; node && node !== scene; node = node.parent) {
      if (throughHip || !node.isBone || !node.parent?.isBone) carriers.add(node);
    }
  }
  fit.updateWorldMatrix(true, true);
  const fromWorld = fit.matrixWorld.clone().invert();
  scene.traverse(node => {
    if (node.isMesh) meshes.push(node);
    if (node.isBone && hipsName.test(node.name)) hips.add(node);
    if (node.isSkinnedMesh && node.skeleton) {
      addChain(node);
      // FBX can put animation bones and skinning bones on alternating levels.
      for (const bone of node.skeleton.bones) if (!bone.parent?.isBone) addChain(bone);
    }
    rest.set(node, { position: node.position.clone(), rotation: node.quaternion.clone(), scale: node.scale.clone() });
  });
  if (meshes.length === 1) addChain(meshes[0]);
  // Rigid models can have several meshes under a single animated armature/group.
  for (let node = meshes[0]?.parent; node && node !== scene; node = node.parent) {
    if (meshes.every(mesh => {
      for (let parent = mesh.parent; parent; parent = parent.parent) if (parent === node) return true;
      return false;
    })) { addChain(node); break; }
  }
  for (const hip of hips) addChain(hip, true);

  const bodyMotion = [...hips].map(node => {
    const basis = new THREE.Matrix3().setFromMatrix4(fromWorld.clone().multiply(node.parent.matrixWorld));
    const determinant = basis.determinant();
    if (!Number.isFinite(determinant) || determinant === 0) return null;
    const inverse = basis.clone().invert();
    const up = new THREE.Vector3(0, 1, 0).applyMatrix3(inverse).normalize();
    return { node, basis, inverse, up, inverseRest: rest.get(node).rotation.clone().invert() };
  }).filter(Boolean);
  const translation = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const twist = new THREE.Quaternion();
  let selectedName, selected;
  const articulatedHips = new Set(bodyMotion.map(({ node }) => node));
  const fixedNodes = [...carriers].filter(node => rest.has(node) && !articulatedHips.has(node));

  function restore(node) {
    const pose = rest.get(node);
    node.position.copy(pose.position);
    node.quaternion.copy(pose.rotation);
    node.scale.copy(pose.scale);
  }

  return name => {
    if (name !== selectedName) {
      selectedName = name;
      selected = name ? THREE.PropertyBinding.findNode(scene, name) : null;
    }
    for (const node of fixedNodes) restore(node);
    if (selected && rest.has(selected) && !carriers.has(selected)) restore(selected);
    for (const { node, basis, inverse, up, inverseRest } of bodyMotion) {
      const pose = rest.get(node);
      translation.copy(node.position).sub(pose.position).applyMatrix3(basis);
      translation.x = translation.z = 0;
      node.position.copy(pose.position).add(translation.applyMatrix3(inverse));
      rotation.copy(node.quaternion).multiply(inverseRest);
      const along = rotation.x * up.x + rotation.y * up.y + rotation.z * up.z;
      twist.set(up.x * along, up.y * along, up.z * along, rotation.w).normalize().invert();
      node.quaternion.copy(rotation.multiply(twist).multiply(pose.rotation));
      node.scale.copy(pose.scale);
    }
  };
}

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
  const tracks = clip.tracks.flatMap((track, index) => {
    if (track.ValueTypeName !== 'vector' || !track.name.endsWith('.position')) return [];
    const binding = THREE.PropertyBinding.parseTrackName(track.name);
    const name = binding.objectName === 'bones' ? binding.objectIndex : binding.nodeName;
    if (requested ? name === requested : preferred.test(name ?? '')) return [{ name, index, priority: 0 }];
    if (!requested && allowHips && hipsName.test(name ?? '')) return [{ name, index, priority: 1 }];
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
