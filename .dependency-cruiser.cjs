/**
 * The architecture's layering, checked on every CI run (`npm run lint:deps`).
 * docs/architecture.md describes these layers; this file is what keeps the
 * description true. Type-only imports are allowed across layers where noted:
 * a shape can be shared without the code that fills it.
 */

/** Code that runs inside web pages (injected or as the content script). */
const PAGE = '^src/executor/(content|tree|page|overlay)\\.ts$';
/** The side panel and the extension's own pages. */
const UI = '^src/(panel|connections-ui|composer|ui|share|dictation/[a-z-]+|export|markdown|welcome|viewer|mic|document)\\.ts$';

module.exports = {
  forbidden: [
    {
      name: 'no-cycles',
      comment: 'Modules depend on each other in one direction.',
      severity: 'error',
      from: {},
      to: { circular: true, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'actions-are-a-contract',
      comment: 'The action registry describes; it does not reach the controller, the loop, the executor or any UI.',
      severity: 'error',
      from: { path: '^src/actions/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/(controller|loop|executor|scope|skills|background|panel)' },
    },
    {
      name: 'input-only-through-the-driver',
      comment: 'An input action reaches the executor only through driver.ts — never commands.ts.',
      severity: 'error',
      from: { path: '^src/executor/input/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/executor/', pathNot: '^src/executor/(input/|driver|page|protocol)' },
    },
    {
      name: 'page-code-stays-in-the-page',
      comment: 'Code that runs in a web page cannot import worker code: it would not be there.',
      severity: 'error',
      from: { path: PAGE },
      to: { path: '^src/', pathNot: PAGE, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'controller-does-not-drive-chrome',
      comment: 'The controller decides; the executor acts. The controller may share the executor\'s types, not its code.',
      severity: 'error',
      from: { path: '^src/controller/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/executor/', pathNot: '^src/executor/protocol\\.ts$', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'loop-goes-through-the-controller',
      comment: 'The agent loop never touches the browser itself: every tool call goes to the controller.',
      severity: 'error',
      from: { path: '^src/loop/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/executor/', pathNot: '^src/executor/protocol\\.ts$', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'ui-is-a-view',
      comment: 'The panel and the extension pages send intents and render state; they run no agent logic.',
      severity: 'error',
      from: { path: UI, pathNot: '\\.test\\.ts$' },
      to: { path: '^src/(loop/agent|controller|executor|scope|background)', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'dictation-stands-alone',
      comment: 'Dictation is self-contained, to be lifted into another extension as it is: it imports nothing of Valet.',
      severity: 'error',
      from: { path: '^src/dictation/' },
      to: { path: '^src/', pathNot: '^src/dictation/' },
    },
    {
      name: 'tests-are-not-imported',
      severity: 'error',
      from: { pathNot: '\\.test\\.ts$' },
      to: { path: '\\.test\\.ts$' },
    },
    {
      name: 'no-orphans',
      comment: 'Every module is reachable from an entry point or a test.',
      severity: 'error',
      // Entry points (the bundles, configs, an e2e fixture extension) are imported by nothing, by design.
      from: { orphan: true, pathNot: ['\\.d\\.ts$', '(^|/)\\.[^/]+\\.(c|m)?js$', '^src/(background|panel|mic|viewer|document|welcome)\\.ts$', 'playwright\\.config\\.ts$', '^e2e/fixtures/planter/'] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['^dist', '^node_modules'] },
    tsPreCompilationDeps: true,
    // TypeScript 7 publishes no JS API yet; swc parses the sources instead.
    parser: 'swc',
    tsConfig: { fileName: 'tsconfig.test.json' },
    enhancedResolveOptions: { extensions: ['.ts', '.js', '.mjs'] },
  },
};
