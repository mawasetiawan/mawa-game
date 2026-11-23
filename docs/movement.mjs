export const Stance = Object.freeze({
  STAND: 'stand', CROUCH: 'crouch', PRONE: 'prone', MOUNTED: 'mounted'
});

export const Gait = Object.freeze({
  STOP: 'stop', WALK: 'walk', RUN: 'run', JUMP: 'jump', SPRINT: 'sprint',
  SWIM: 'swim', RAPID_SWIM: 'rapid swim', FLY: 'fly', RAPID_FLY: 'rapid fly',
  DASH: 'dash', TELEPORT: 'teleport'
});

export const ActorState = Object.freeze({
  GROUNDED: 'grounded', IN_AIR: 'in air', FALLING: 'falling',
  ON_WATER: 'on water', CONSTRAINED: 'constrained'
});

import { defaults } from './game-settings.mjs?v=1';

export function createMovement() {
  return {
    x: 0, y: 0, z: 0, facingX: 0, facingZ: -1, verticalSpeed: 0, dashLeft: 0,
    stance: Stance.STAND, gait: Gait.STOP, state: ActorState.GROUNDED
  };
}

export function stepMovement(actor, input, dt, settings = defaults) {
  const magnitude = Math.hypot(input.x, input.z);
  const moving = magnitude > 0.08;
  const strength = Math.min(1, magnitude);
  const x = moving ? input.x / magnitude : 0;
  const z = moving ? input.z / magnitude : 0;
  const grounded = actor.state === ActorState.GROUNDED;

  if (grounded && input.crouch) {
    actor.stance = actor.stance === Stance.CROUCH ? Stance.STAND : Stance.CROUCH;
  }
  if (!actor.dashLeft && moving) {
    actor.facingX = x;
    actor.facingZ = z;
  }
  if (grounded && input.dash && actor.stance === Stance.STAND && !actor.dashLeft) {
    actor.dashLeft = settings.dashSeconds;
  }
  if (grounded && input.jump && !actor.dashLeft) {
    actor.verticalSpeed = settings.jumpSpeed;
    actor.state = ActorState.IN_AIR;
  }

  let remaining = dt;
  if (actor.dashLeft > 0) {
    const time = Math.min(dt, actor.dashLeft);
    actor.x += actor.facingX * settings.dashSpeed * time;
    actor.z += actor.facingZ * settings.dashSpeed * time;
    actor.dashLeft = Math.max(0, actor.dashLeft - time);
    remaining -= time;
  }
  const locomotion = actor.stance === Stance.CROUCH ? Gait.WALK :
    input.sprint ? Gait.SPRINT : input.walk ? Gait.WALK : Gait.RUN;
  if (moving && remaining > 0) {
    const speed = locomotion === Gait.WALK ? settings.walkSpeed : locomotion === Gait.SPRINT ? settings.sprintSpeed : settings.runSpeed;
    actor.x += x * speed * strength * remaining;
    actor.z += z * speed * strength * remaining;
  }
  if (actor.state !== ActorState.GROUNDED) {
    actor.verticalSpeed -= settings.gravity * dt;
    actor.y = Math.max(0, actor.y + actor.verticalSpeed * dt);
    if (!actor.y) actor.verticalSpeed = 0;
    actor.state = !actor.y ? ActorState.GROUNDED :
      actor.verticalSpeed > 0 ? ActorState.IN_AIR : ActorState.FALLING;
  }
  actor.gait = actor.dashLeft > 0 ? Gait.DASH :
    actor.state !== ActorState.GROUNDED ? Gait.JUMP : moving ? locomotion : Gait.STOP;
}
