import { detect } from './detector';

/** Authored static fixtures. None of these sources are executed. */
function dispatcher(order = "'finish|start|work'.split('|')", test = 'true'): string {
  return `const order = ${order}; let cursor = 0;
    while (${test}) {
      switch (order[cursor++]) {
        case 'start': record('start'); continue;
        case 'work': record('work'); continue;
        case 'finish': record('finish'); continue;
      }
      break;
    }`;
}

describe('static order dispatch candidate regression', () => {
  it.each([
    ["'finish|start|work'.split('|')", 'true'],
    ["'finish|start|work'['split']('|')", '!![]'],
    ["['finish', 'start', 'work']", '!0'],
  ])('selects a reordered dispatch without helper functions (%s)', (order, test) => {
    const verdict = detect('arbitrary.js', dispatcher(order, test));
    expect(verdict.features.controlFlowIndirectionCount).toBe(0);
    expect(verdict.structuralCandidate).toBe(true);
    expect(verdict.signals).toContain('CONTROL_FLOW_FLATTENING');
  });

  it('does not depend on variable names or case labels', () => {
    const source = dispatcher().replaceAll('order', 'schedule').replaceAll('cursor', 'offset')
      .replaceAll('start', 'a').replaceAll('work', 'b').replaceAll('finish', 'c');
    expect(detect('renamed.js', source).structuralCandidate).toBe(true);
  });

  it('supports var declarations reinitialized at the start of an outer loop iteration', () => {
    const source = `while (readNext()) { ${dispatcher().replace('const order', 'var order').replace('let cursor', 'var cursor')} }`;
    expect(detect('nested.js', source).structuralCandidate).toBe(true);
  });

  it('ignores formatting and comments between dispatch tokens', () => {
    const source = dispatcher().replace('switch (', 'switch /* note */ (')
      .replace('cursor++', 'cursor /* cursor */ ++');
    expect(detect('comments.js', source).structuralCandidate).toBe(true);
  });

  it('accepts typed numeric order entries and matching numeric cases', () => {
    const source = dispatcher("['finish', 'start', 'work']")
      .replaceAll("'start'", '0').replaceAll("'work'", '1').replaceAll("'finish'", '2');
    expect(detect('numbers.js', source).structuralCandidate).toBe(true);
  });

  it.each([
    ['ordinary loop', 'while (!![]) { if (done()) break; consume(); }'],
    ['runtime dispatch order', dispatcher('readCommands()')],
    ['ordered commands', dispatcher("['start', 'work', 'finish']")],
    ['unknown case', dispatcher("['missing', 'start', 'work']")],
    ['duplicate order entries', dispatcher("['finish', 'finish', 'start']")],
    ['runtime loop condition', dispatcher(undefined, 'available()')],
    ['prefix increment', dispatcher().replace('cursor++', '++cursor')],
    ['nonzero cursor', dispatcher().replace('cursor = 0', 'cursor = 1')],
    ['fallthrough cases', dispatcher().replaceAll('continue;', '')],
    ['default branch', dispatcher().replace("case 'finish':", 'default:')],
    ['mutated order', dispatcher().replace('while (true)', "order.reverse(); while (true)")],
    ['reassigned cursor', dispatcher().replace("record('work');", "cursor = 0; record('work');")],
    ['redeclaration changes order', dispatcher().replace('const order', 'var order').replace('while (true)', "var order = readCommands(); while (true)")],
    ['shadowed order', dispatcher().replace('switch (order', "const order = readCommands(); switch (order")],
    ['conditional initialization', dispatcher().replace("const order = 'finish|start|work'.split('|');", "if (ready) { var order = 'finish|start|work'.split('|'); }")],
    ['string containing dispatcher', `const text = ${JSON.stringify(dispatcher())};`],
    ['comment containing dispatcher', `/* ${dispatcher()} */`],
    ['invalid source', dispatcher() + '\n const = ;'],
  ])('does not promote %s', (_name, source) => {
    expect(detect('negative.js', source).structuralCandidate).toBe(false);
  });
});
