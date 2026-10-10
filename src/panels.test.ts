import { describe, expect, it } from 'vitest';
import { agentPanelPaths, panelAssignments } from './panels.js';

const snapshot = { sessions: [
  ['tab:5', { tabs: [['handed', 5], ['tab-a', 9], ['tab-b', 12]], active: 'tab-a', handed: ['handed'] }],
  ['main', { tabs: [['tab-c', 20]], active: 'tab-c', handed: [] }],
] };

describe('panels per tab', () => {
  it('gives an agent tab the panel of the conversation it belongs to, and the owner\'s tab its own', () => {
    expect([...agentPanelPaths(snapshot)]).toEqual([[9, 'panel.html?tab=5'], [12, 'panel.html?tab=5']]);
    expect([...panelAssignments([5, 9, 12, 20, 33], snapshot)]).toEqual([
      [9, 'panel.html?tab=5'], [12, 'panel.html?tab=5'], [5, 'panel.html?tab=5'], [20, 'panel.html?tab=20'], [33, 'panel.html?tab=33'],
    ]);
  });

  it('with no snapshot, every tab gets its own', () => {
    expect([...panelAssignments([1, 2], undefined)]).toEqual([[1, 'panel.html?tab=1'], [2, 'panel.html?tab=2']]);
    expect([...panelAssignments([1], { sessions: 'junk' })]).toEqual([[1, 'panel.html?tab=1']]);
  });
});
