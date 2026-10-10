/* Rules shared by the actions that aim at something: an element or a point, never both. */

import type { Call, Issue } from './spec.js';

/** click, hover and drag aim at a target (a ref) or at a point on the latest screenshot. */
export function targetOrPoint(call: Call, issue: Issue): void {
  if (!call.target && !call.point) issue(['target'], `${call.action} needs a target (a ref from observation.targets) or a point on the latest screenshot`);
  if (call.target && call.point) issue(['point'], 'Use a target or a point, not both');
}
