import { OPERATIONS } from "./contracts.js";
import { createPlan, detectIntent, routesOf } from "./plan.js";

/**
 * Compatibility facade.
 *
 * Routing decisions now live in `src/plan.js`, where a route is one read inside a bounded
 * plan with declared obligations rather than a bare string. This module keeps the previous
 * `route()` entry point so existing importers and tests do not break in the same change.
 */

export { OPERATIONS, detectIntent };

/**
 * @returns {string[]} `backend:operation` pairs in execution order; empty for control operations.
 */
export function route(input) {
  const operation = input.operation ?? "auto";
  if (!OPERATIONS.includes(operation)) throw new Error(`unsupported operation: ${operation}`);
  return routesOf(createPlan({ ...input, operation }));
}
