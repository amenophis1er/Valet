/*
 * The browser tool's actions: what the model may ask for, in one place.
 * (Re-exports for now; the definitions move here next.)
 */
export { ACTING, ACTIONS, BROWSER_TOOL, KEYS, TOOL_DESCRIPTION, UNTRUSTED, WIRE_SCHEMA, commandSchema, type BrowserCommand } from '../controller/schema.js';
export { describe as describeStep } from '../loop/agent.js';
