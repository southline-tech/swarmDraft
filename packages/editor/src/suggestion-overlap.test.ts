import { describe, expect, it } from 'vitest';
import { createManuscriptEditor } from './index';
import {
  findOverlapClusters,
  gatherSuggestionSpans,
  gutterClustersForFilter,
  gutterDotAriaLabel,
  overlapBadgeAriaLabel,
  type SuggestionSpan,
} from './suggestion-overlap';

describe('suggestion overlap (#179)', () => {
  const span = (from: number, to: number, author: string, id: string): SuggestionSpan => ({
    from,
    to,
    author,
    kind: 'suggestion_insert',
    id,
  });

  it('findOverlapClusters merges intersecting spans from different authors', () => {
    const clusters = findOverlapClusters([
      span(1, 5, 'agent:a', 'x1'),
      span(1, 5, 'agent:b', 'y1'),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.spans).toHaveLength(2);
  });

  it('ignores non-overlapping spans', () => {
    expect(
      findOverlapClusters([span(1, 3, 'agent:a', 'a'), span(4, 6, 'agent:b', 'b')]),
    ).toHaveLength(0);
  });

  it('gutterClustersForFilter finds hidden authors in a scoped view', () => {
    const clusters = findOverlapClusters([
      span(1, 5, 'agent:a', 'x1'),
      span(1, 5, 'agent:b', 'y1'),
    ]);
    const gutters = gutterClustersForFilter(clusters, 'agent:a');
    expect(gutters).toHaveLength(1);
    expect(gutters[0]!.hiddenAuthors).toEqual(['agent:b']);
    expect(gutterDotAriaLabel(1, (a) => (a === 'agent:b' ? 'Continuity' : a), 'agent:b')).toBe(
      '1 more from Continuity · Show',
    );
  });

  it('overlapBadgeAriaLabel lists authors for All view', () => {
    const cluster = findOverlapClusters([
      span(1, 4, 'agent:a', 'x1'),
      span(1, 4, 'brett', 'y1'),
    ])[0]!;
    expect(overlapBadgeAriaLabel(cluster, (a) => (a === 'agent:a' ? 'Bot' : 'Mara'))).toBe(
      '2 suggestions, by Bot and Mara',
    );
  });

  it('gatherSuggestionSpans reads overlapping marks from the live doc', () => {
    const e = createManuscriptEditor({
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { style: 'body' },
            content: [
              {
                type: 'text',
                text: 'word',
                marks: [
                  {
                    type: 'suggestion_insert',
                    attrs: { id: 's1', author: 'agent:a', ts: 't' },
                  },
                  {
                    type: 'suggestion_insert',
                    attrs: { id: 's2', author: 'agent:b', ts: 't' },
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const spans = gatherSuggestionSpans(e.state.doc);
    expect(spans).toHaveLength(2);
    expect(findOverlapClusters(spans)).toHaveLength(1);
    e.destroy();
  });
});
