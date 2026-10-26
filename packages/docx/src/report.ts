export type ReportLevel = 'info' | 'warning';

export interface ReportItem {
  level: ReportLevel;
  /** Stable machine-readable code, e.g. `unmapped_paragraph_style`. */
  code: string;
  message: string;
  count: number;
  /** A few short examples (style names, first words of a paragraph). */
  samples: string[];
}

export interface ImportSummary {
  frontMatter: number;
  parts: number;
  chapters: number;
  scenes: number;
  sceneBreaks: number;
  backMatter: number;
  footnotes: number;
  comments: number;
  suggestions: number;
  paragraphs: number;
}

export interface ImportReport {
  summary: ImportSummary;
  items: ReportItem[];
}

export class ReportBuilder {
  private items = new Map<string, ReportItem>();

  add(level: ReportLevel, code: string, message: string, sample?: string): void {
    const key = `${code}\u0000${message}`;
    let item = this.items.get(key);
    if (!item) {
      item = { level, code, message, count: 0, samples: [] };
      this.items.set(key, item);
    }
    item.count++;
    if (sample !== undefined && item.samples.length < 3) {
      const s = sample.length > 60 ? `${sample.slice(0, 57)}...` : sample;
      if (!item.samples.includes(s)) item.samples.push(s);
    }
  }

  list(): ReportItem[] {
    return [...this.items.values()].sort((a, b) =>
      a.level === b.level ? a.code.localeCompare(b.code) : a.level === 'warning' ? -1 : 1,
    );
  }
}

/** Human-readable import report (Markdown) for the import dialog / log file. */
export function formatReport(report: ImportReport): string {
  const s = report.summary;
  const lines = [
    '# Import report',
    '',
    `- Front matter sections: ${s.frontMatter}`,
    `- Parts: ${s.parts}`,
    `- Chapters: ${s.chapters}`,
    `- Scenes: ${s.scenes} (scene breaks: ${s.sceneBreaks})`,
    `- Back matter sections: ${s.backMatter}`,
    `- Footnotes: ${s.footnotes}, comments: ${s.comments}, tracked changes: ${s.suggestions}`,
    '',
  ];
  for (const level of ['warning', 'info'] as const) {
    const items = report.items.filter((i) => i.level === level);
    if (!items.length) continue;
    lines.push(level === 'warning' ? '## Needs attention' : '## Notes', '');
    for (const i of items) {
      const samples = i.samples.length
        ? ` (e.g. ${i.samples.map((x) => `"${x}"`).join(', ')})`
        : '';
      lines.push(`- ${i.message} x${i.count}${samples}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
