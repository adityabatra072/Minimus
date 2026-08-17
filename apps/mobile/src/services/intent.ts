/**
 * The app's intent routing lives in @minimus/agent-core so the eval rig can
 * run the SHIPPING router instead of a hand-copied mirror of it. A rig that
 * mirrors the routing tests what we believe the app does; importing it tests
 * what the app does.
 *
 * Kept as a re-export so app-side import paths stay stable.
 */
export {
  composeRun,
  routeToolGroups,
  deferredPreamble,
  deferredToolExclusions,
  macroSteering,
  teachingPreamble,
  isTeaching,
  teachingToolExclusions,
} from '@minimus/agent-core';
