import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(__dirname, '..', '..', 'src', 'web', 'app.js'), 'utf8');

/** Just enough of a DOM node to build the zone list and read it back. */
class FakeNode {
  className = '';
  textContent = '';
  children: (FakeNode | string)[] = [];
  constructor(readonly tag: string) {}
  append(...nodes: (FakeNode | string)[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: FakeNode[]): void {
    this.children = nodes;
  }
}

interface Sensor {
  name: string;
  category: string;
  currentState: string;
  connectivityStatus: string;
  batteryLevel: number | null;
}
interface Zone {
  id: string;
  name: string;
  sensors: Sensor[];
}

/** The dashboard is a plain browser script, so its rendering functions are lifted out of the source and run here. */
function renderZones(zones: Zone[], disarmedZoneIds: string[] = []): FakeNode {
  const start = source.indexOf('function element(');
  const end = source.indexOf('function applySensorPatch(');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const list = new FakeNode('ul');
  const run = new Function(
    'document',
    'state',
    'el',
    'LOW_BATTERY_THRESHOLD_PERCENT',
    `${source.slice(start, end)}; return renderZones;`,
  ) as (...args: unknown[]) => () => void;
  run({ createElement: (tag: string) => new FakeNode(tag) }, { zones, panel: { disarmedZoneIds } }, { zoneList: list }, 20)();
  return list;
}

/** Every element tag and every piece of text in the tree, so a test can say what was (not) created. */
function walk(node: FakeNode | string, tags: string[] = [], texts: string[] = []): { tags: string[]; texts: string[] } {
  if (typeof node === 'string') {
    texts.push(node);
    return { tags, texts };
  }
  tags.push(node.tag);
  if (node.textContent) texts.push(node.textContent);
  node.children.forEach((child) => walk(child, tags, texts));
  return { tags, texts };
}

const sensor = (name: string, overrides: Partial<Sensor> = {}): Sensor => ({
  name,
  category: 'intrusion',
  currentState: 'normal',
  connectivityStatus: 'online',
  batteryLevel: 90,
  ...overrides,
});

describe('dashboard zone list', () => {
  it('shows markup in a zone or sensor name as text, never as elements', () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const tree = renderZones([{ id: 'z', name: hostile, sensors: [sensor(hostile)] }]);

    const { tags, texts } = walk(tree);

    expect(tags).not.toContain('img');
    expect(tags.filter((tag) => tag === 'li')).toHaveLength(2); // the zone card and the sensor row
    expect(texts.filter((text) => text.includes(hostile))).toHaveLength(2); // as the two names' text
  });

  it('renders the same structure as before: zone card, sensor rows, badges', () => {
    const tree = renderZones(
      [{ id: 'z', name: 'House', sensors: [sensor('Door', { currentState: 'breached', connectivityStatus: 'offline', batteryLevel: 10 })] }],
      ['z'],
    );

    const card = tree.children[0] as FakeNode;
    expect(card.className).toBe('zone-card');
    const [title, sensors] = card.children as FakeNode[];
    expect(title.tag).toBe('h3');
    expect(title.textContent).toBe('House');
    expect(walk(title).texts).toContain('zone disarmed');
    const row = sensors.children[0] as FakeNode;
    expect(row.className).toBe('sensor-row');
    const badges = row.children.filter((child): child is FakeNode => typeof child !== 'string' && child.tag === 'span' && child.className.includes('badge'));
    expect(badges.map((badge) => badge.textContent)).toEqual(['breached', 'offline', 'low battery (10%)']);
    expect(badges[0].className).toContain('badge-breached');
  });

  it('says so when a zone has no sensors, and leaves out badges that do not apply', () => {
    const tree = renderZones([
      { id: 'a', name: 'Empty', sensors: [] },
      { id: 'b', name: 'Fine', sensors: [sensor('Window')] },
    ]);

    expect(walk(tree.children[0] as FakeNode).texts).toContain('No sensors assigned.');
    const fine = walk(tree.children[1] as FakeNode).texts;
    expect(fine).toContain('normal');
    expect(fine).not.toContain('offline');
    expect(fine.some((text) => text.startsWith('low battery'))).toBe(false);
    expect(fine).not.toContain('zone disarmed');
  });

  it('builds nothing from HTML strings at all', () => {
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });
});
