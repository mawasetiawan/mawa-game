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
    dashX: 0, dashZ: -1,
    stance: Stance.STAND, gait: Gait.STOP, state: ActorState.GROUNDED
  };
}

export function availableLocomotion(canAnimate) {
  const walk = canAnimate(Gait.WALK);
  const run = canAnimate(Gait.RUN);
  const sprint = canAnimate(Gait.SPRINT);
  return {
    defaultGait: run ? Gait.RUN : walk ? Gait.WALK : sprint ? Gait.SPRINT : Gait.STOP,
    walkToggle: walk && run,
    sprintHold: sprint && (run || walk),
  };
}

export function stepMovement(actor, input, dt, settings = defaults, canAnimate = () => true, characterMotion) {
  const magnitude = Math.hypot(input.x, input.z);
  const moving = magnitude > 0.08;
  const strength = Math.min(1, magnitude);
  const x = moving ? input.x / magnitude : 0;
  const z = moving ? input.z / magnitude : 0;
  const grounded = actor.state === ActorState.GROUNDED;

  if (grounded && input.crouch && (actor.stance === Stance.CROUCH || canAnimate('crouchIdle'))) {
    actor.stance = actor.stance === Stance.CROUCH ? Stance.STAND : Stance.CROUCH;
  }
  if (!actor.dashLeft && moving) {
    const current = Math.atan2(actor.facingX, actor.facingZ);
    const target = Math.atan2(x, z);
    const turn = Math.atan2(Math.sin(target - current), Math.cos(target - current));
    const yaw = current + turn * (1 - Math.exp(-14 * dt));
    actor.facingX = Math.sin(yaw);
    actor.facingZ = Math.cos(yaw);
  }
  if (grounded && input.dash && actor.stance === Stance.STAND && !actor.dashLeft && canAnimate('dash')) {
    actor.dashLeft = settings.dashSeconds;
    actor.dashX = moving ? x : actor.facingX;
    actor.dashZ = moving ? z : actor.facingZ;
  }
  if (grounded && input.jump && !actor.dashLeft && canAnimate('jump')) {
    actor.verticalSpeed = settings.jumpSpeed;
    actor.state = ActorState.IN_AIR;
  }

  let remaining = dt;
  if (actor.dashLeft > 0) {
    const time = Math.min(dt, actor.dashLeft);
    actor.x += actor.dashX * settings.dashSpeed * time;
    actor.z += actor.dashZ * settings.dashSpeed * time;
    actor.dashLeft = Math.max(0, actor.dashLeft - time);
    remaining -= time;
  }
  const available = availableLocomotion(canAnimate);
  const locomotion = actor.stance === Stance.CROUCH ? Gait.WALK :
    input.sprint && available.sprintHold ? Gait.SPRINT :
      input.walk && available.walkToggle ? Gait.WALK : available.defaultGait;
  const canMove = moving && (actor.stance === Stance.CROUCH ? canAnimate('crouchMove') : locomotion !== Gait.STOP);
  const previousPhase = actor.locomotionPhase;
  actor.locomotionPhase = undefined;
  if (canMove && remaining > 0) {
    const speed = locomotion === Gait.WALK ? settings.walkSpeed : locomotion === Gait.SPRINT ? settings.sprintSpeed : settings.runSpeed;
    const slot = actor.stance === Stance.CROUCH ? 'crouchMove' : locomotion;
    const delta = actor.state === ActorState.GROUNDED && !actor.action ?
      characterMotion?.(actor, slot, previousPhase, remaining, strength, x, z) : undefined;
    actor.x += delta?.x ?? x * speed * strength * remaining;
    actor.z += delta?.z ?? z * speed * strength * remaining;
  }
  if (actor.state !== ActorState.GROUNDED) {
    actor.verticalSpeed -= settings.gravity * dt;
    actor.y = Math.max(0, actor.y + actor.verticalSpeed * dt);
    if (!actor.y) actor.verticalSpeed = 0;
    actor.state = !actor.y ? ActorState.GROUNDED :
      actor.verticalSpeed > 0 ? ActorState.IN_AIR : ActorState.FALLING;
  }
  actor.gait = actor.dashLeft > 0 ? Gait.DASH :
    actor.state !== ActorState.GROUNDED ? Gait.JUMP : canMove ? locomotion : Gait.STOP;
}
