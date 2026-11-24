import { createCameraEffects } from './camera-effects.mjs';
import { decodeCameraScript, sampleCameraScript } from './scripted-camera.mjs';
import { bindOrbit } from './orbit.mjs?v=3';
import { resolveFov } from './game-settings.mjs?v=4';

const rad = Math.PI / 180;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function createCameraRig(THREE, canvas, camera, actor, settings, getCamera, signal) {
  const { orbit, clampDistance } = bindOrbit(canvas, settings, signal, {
    drag(dx, dy) {
      if (config.mode === 'follow') return false;
      if (script?.input.orbit) {
        scriptYaw -= dx * .004 * settings.orbitSpeed * (settings.invertYaw ? -1 : 1);
        scriptPitch = clamp(scriptPitch + dy * .004 * settings.orbitSpeed * (settings.invertPitch ? -1 : 1), -1.2, 1.2);
      }
      if (config.mode === 'fps') {
        yaw -= dx * .004 * config.look * (settings.invertYaw ? -1 : 1);
        pitch = clamp(pitch + dy * .004 * config.look * (settings.invertPitch ? -1 : 1), -1.5, 1.5);
      }
      if (config.mode === 'rts') {
        const units = 2 * distance * Math.tan(config.fov * rad / 2) / Math.max(canvas.clientHeight, 1);
        const right = -dx * units * config.grab;
        const forward = -dy * units * config.grab / Math.max(.25, Math.sin(pitch));
        const angle = yaw;
        groundX = clamp(groundX + right * Math.cos(angle) + forward * Math.sin(angle), -49, 49);
        groundZ = clamp(groundZ - right * Math.sin(angle) + forward * Math.cos(angle), -49, 49);
      }
      return true;
    },
    canOrbit,
    orbitDrag(dx, dy) {
      if (!canOrbit()) return;
      yaw -= dx * .004 * config.orbitLookSpeed * (settings.invertYaw ? -1 : 1);
      pitch = clamp(pitch + dy * .004 * config.orbitLookSpeed * (settings.invertPitch ? -1 : 1), 25 * rad, 89 * rad);
    },
    twist(delta) {
      if (canOrbit()) yaw -= delta * config.orbitLookSpeed * (settings.invertYaw ? -1 : 1);
    },
    zoom(amount) {
      if (config.mode === 'follow') return false;
      if (script?.input.zoom) scriptZoom = clamp(scriptZoom * Math.exp(amount * settings.zoomSpeed * (settings.invertZoom ? -1 : 1)), .25, 4);
      if (config.mode === 'drone') {
        distance = clamp(distance * Math.exp(amount * config.zoom * (settings.invertZoom ? -1 : 1)), 2, 40);
      }
      if (config.mode === 'rts') {
        distance = clamp(distance * Math.exp(amount * config.zoom * (settings.invertZoom ? -1 : 1)),
          config.minZoom, config.maxZoom);
      }
      return true;
    },
  });
  const anchor = new THREE.Vector3();
  const position = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const orientation = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const view = new THREE.Matrix4();
  let config = { mode: 'follow', smoothing: .14 };
  let yaw = 0, pitch = 0, distance = 17;
  let groundX = 0, groundZ = 0;
  let droneHeight = 9;
  let previousX = actor.x, previousZ = actor.z;
  let leadX = 0, leadZ = 0;
  let initialized = false;
  let script, scriptTime = 0, scriptYaw = 0, scriptPitch = 0, scriptZoom = 1;
  let effects, impact = false;
  let appliedYaw = 0, appliedPitch = 0, appliedZoom = 1, scriptMovementYaw = 0;
  let modeBlend = 0, blendRemaining = 0;
  canvas.closest?.('.world')?.addEventListener('player-impact', () => { impact = true; }, { signal });
  const pose = { position: [0, 0, 0], target: [0, 0, 0], fov: 58 };

  function updateConfig() {
    const next = getCamera();
    if (!next || next === config) return;
    if (next.mode === 'rts' && config.mode !== 'rts') {
      groundX = actor.x;
      groundZ = actor.z;
    }
    if (next.mode === 'rts') {
      if (config.mode !== 'rts' || next.yaw !== config.yaw || (config.orbitLook && !next.orbitLook)) yaw = next.yaw * rad;
      if (config.mode !== 'rts' || next.pitch !== config.pitch || (config.orbitLook && !next.orbitLook)) pitch = next.pitch * rad;
    }
    if (next.mode === 'fps' && config.mode !== 'fps') {
      yaw = heading();
      pitch = 0;
    }
    if (next.mode === 'drone') {
      if (config.mode !== 'drone' || next.yaw !== config.yaw) yaw = next.yaw * rad;
      if (config.mode !== 'drone' || next.altitude !== config.altitude) droneHeight = next.altitude;
      if (config.mode !== 'drone' || next.distance !== config.distance) distance = next.distance;
    }
    if (next.mode === 'rts' && (config.mode !== 'rts' || next.distance !== config.distance)) distance = next.distance;
    if (next.mode === 'rts') distance = clamp(distance, next.minZoom, next.maxZoom);
    if (config.mode === 'scripted' && next.mode !== 'scripted') {
      modeBlend = script.blend.exit;
      blendRemaining = modeBlend * 4;
    }
    if (next.mode === 'scripted') {
      if (!next.script) { script = undefined; config = { mode: 'follow', smoothing: .14 }; return; }
      if (config.mode !== 'scripted' || next.script !== config.script) {
        scriptMovementYaw = heading();
        script = decodeCameraScript(next.script);
        effects = createCameraEffects(script);
        modeBlend = script.blend.enter;
        blendRemaining = modeBlend * 4;
        impact = false;
        appliedYaw = appliedPitch = 0;
        appliedZoom = 1;
        scriptTime = scriptYaw = scriptPitch = 0;
        scriptZoom = 1;
      }
    } else script = undefined;
    config = next;
  }

  function canOrbit() {
    return config.mode === 'rts' && config.orbitLook;
  }

  function heading() {
    if (config.mode === 'follow') return orbit.yaw;
    if (config.mode === 'scripted' && script?.space !== 'world') return scriptMovementYaw;
    if (config.mode === 'scripted') return Math.atan2(camera.position.x - lookAt.x, camera.position.z - lookAt.z);
    return ['fps', 'drone', 'rts'].includes(config.mode) ? yaw : config.yaw * rad;
  }

  return {
    heading() { updateConfig(); return heading(); },
    update(dt, capsule, heightScale) {
      updateConfig();
      const mode = config.mode;
      const angle = heading();
      let smoothing = config.smoothing;
      const speedX = dt > 0 ? (actor.x - previousX) / dt : 0;
      const speedZ = dt > 0 ? (actor.z - previousZ) / dt : 0;
      let fov = config.fov;
      if (dt > 0) {
        const leadBlend = 1 - Math.exp(-dt / .18);
        const maxLeadSpeed = 18;
        leadX += (clamp((actor.x - previousX) / dt, -maxLeadSpeed, maxLeadSpeed) - leadX) * leadBlend;
        leadZ += (clamp((actor.z - previousZ) / dt, -maxLeadSpeed, maxLeadSpeed) - leadZ) * leadBlend;
      }
      previousX = actor.x;
      previousZ = actor.z;
      capsule.visible = mode !== 'fps';
      if (mode === 'scripted' && script) {
        sampleCameraScript(script, scriptTime, pose);
        scriptTime += dt;
        const base = script.anchor === 'player' ? actor : { x: 0, y: 0, z: 0 };
        const dynamic = effects.update(actor, speedX, speedZ, dt, impact);
        const relativeYaw = dynamic.yaw;
        smoothing = dynamic.mods.smoothing ?? smoothing;
        const inputMix = script.blend.input ? 1 - Math.exp(-dt / script.blend.input) : 1;
        appliedYaw += (scriptYaw - appliedYaw) * inputMix;
        appliedPitch += (scriptPitch - appliedPitch) * inputMix;
        appliedZoom += (scriptZoom - appliedZoom) * inputMix;
        const x = pose.position[0] - pose.target[0];
        const y = pose.position[1] - pose.target[1];
        const z = pose.position[2] - pose.target[2];
        const horizontal = Math.hypot(x,z);
        const range = Math.max(.1, Math.hypot(horizontal,y) * appliedZoom * dynamic.mods.distance);
        const angle = Math.atan2(x,z) + relativeYaw + appliedYaw + dynamic.mods.yaw * rad;
        const tilt = clamp(Math.atan2(y,horizontal) + appliedPitch + dynamic.mods.pitch * rad, -1.555, 1.555);
        const [tx, ty, tz] = pose.target;
        lookAt.set(base.x + tx * Math.cos(relativeYaw) + tz * Math.sin(relativeYaw),
          base.y + ty, base.z + tz * Math.cos(relativeYaw) - tx * Math.sin(relativeYaw));
        position.set(lookAt.x + Math.sin(angle) * Math.cos(tilt) * range,
          lookAt.y + Math.sin(tilt) * range, lookAt.z + Math.cos(angle) * Math.cos(tilt) * range);
        const [sx, sy, sz] = dynamic.shake;
        position.x += sx * Math.cos(angle) + sz * Math.sin(angle);
        position.y += sy;
        position.z += sz * Math.cos(angle) - sx * Math.sin(angle);
        fov = pose.fov;
      } else if (mode === 'fps') {
        position.set(actor.x - Math.sin(angle) * config.offset, actor.y + config.height * heightScale,
          actor.z - Math.cos(angle) * config.offset);
        lookAt.set(position.x - Math.sin(angle) * Math.cos(pitch), position.y - Math.sin(pitch),
          position.z - Math.cos(angle) * Math.cos(pitch));
      } else if (mode === 'drone') {
        position.set(actor.x + Math.sin(angle) * distance, actor.y + droneHeight,
          actor.z + Math.cos(angle) * distance);
        lookAt.set(actor.x + leadX * config.lead, actor.y + config.height, actor.z + leadZ * config.lead);
      } else {
        clampDistance();
        const range = mode === 'follow' ? orbit.distance : mode === 'rts' ? distance : config.distance;
        const tilt = mode === 'follow' ? orbit.pitch : mode === 'rts' ? pitch : config.pitch * rad;
        if (mode === 'follow') fov = resolveFov(settings, range);
        if (mode === 'rts') anchor.set(groundX, 0, groundZ);
        else anchor.set(actor.x, actor.y + (mode === 'follow' ? .95 : config.height), actor.z);
        const horizontal = Math.cos(tilt) * range;
        position.set(anchor.x + Math.sin(angle) * horizontal, anchor.y + Math.sin(tilt) * range,
          anchor.z + Math.cos(angle) * horizontal);
        lookAt.copy(anchor);
      }
      impact = false;
      if (blendRemaining > 0) {
        smoothing = Math.max(smoothing, modeBlend * blendRemaining / (modeBlend * 4));
        blendRemaining = Math.max(0, blendRemaining - dt);
      }
      const blend = !initialized || !smoothing ? 1 : 1 - Math.exp(-dt / smoothing);
      orientation.setFromRotationMatrix(view.lookAt(position, lookAt, up));
      camera.position.lerp(position, blend);
      camera.quaternion.slerp(orientation, blend);
      if (Math.abs(camera.fov - fov) > .001) {
        camera.fov += (fov - camera.fov) * blend;
        camera.updateProjectionMatrix();
      }
      initialized = true;
    },
  };
}
