import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(__dirname, '..', '..', 'src', 'web', 'app.js'), 'utf8');

/** The dashboard is a plain browser script, so its helper is lifted out of the source and run here. */
function loadEscapeHtml(): (text: unknown) => string {
  const match = /function escapeHtml\(text\) \{[\s\S]*?\n\}/.exec(source);
  expect(match).not.toBeNull();
  return new Function(`${match![0]}; return escapeHtml;`)() as (text: unknown) => string;
}

describe('dashboard HTML escaping', () => {
  it('turns markup in a name into inert text', () => {
    const escapeHtml = loadEscapeHtml();

    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(escapeHtml("Tom's & Jerry's <door>")).toBe('Tom&#39;s &amp; Jerry&#39;s &lt;door&gt;');
    expect(escapeHtml(42)).toBe('42');
  });

  it('is applied to every name and category written into an HTML template', () => {
    // A raw ${zone.name} / ${sensor.name} / ${sensor.category} in a template would bring the injection back.
    const rawInterpolations = source.match(/\$\{(?:zone|sensor)\.(?:name|category|currentState)\}/g) ?? [];

    expect(rawInterpolations).toEqual([]);
    expect(source).toContain('${escapeHtml(zone.name)}');
    expect(source).toContain('${escapeHtml(sensor.name)}');
  });
});
