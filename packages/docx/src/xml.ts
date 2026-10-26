/** Minimal, dependency-free XML reader/writer for OOXML parts. */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
export type XmlNode = XmlElement | string;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function parseXml(src: string): XmlElement {
  // DTDs enable entity-expansion attacks and never appear in valid OOXML parts.
  if (/<!DOCTYPE|<!ENTITY/i.test(src))
    throw new Error('XML with a DOCTYPE/ENTITY declaration is not allowed');
  const root: XmlElement = { name: '#root', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  const re =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([^\s/>]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.children.push(m[1]);
    else if (m[6] !== undefined) top.children.push(decodeEntities(m[6]));
    else if (m[3] !== undefined) {
      if (m[2] === '/') {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const attrs: Record<string, string> = {};
      const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      while ((a = attrRe.exec(m[4] ?? ''))) attrs[a[1]!] = decodeEntities(a[3] ?? a[4] ?? '');
      const el: XmlElement = { name: m[3], attrs, children: [] };
      top.children.push(el);
      if (m[5] !== '/') stack.push(el);
    }
  }
  const doc = root.children.find((c): c is XmlElement => typeof c !== 'string');
  if (!doc) throw new Error('XML has no root element');
  return doc;
}

export function kids(el: XmlElement | undefined, name?: string): XmlElement[] {
  if (!el) return [];
  return el.children.filter(
    (c): c is XmlElement => typeof c !== 'string' && (name === undefined || c.name === name),
  );
}

export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  return kids(el, name)[0];
}

/** w:val style attribute; returns undefined when the element is absent. */
export function val(el: XmlElement | undefined, name: string): string | undefined {
  const c = child(el, name);
  return c ? (c.attrs['w:val'] ?? '') : undefined;
}

/** OOXML on/off property: present and not "0"/"false"/"off". */
export function onOff(el: XmlElement | undefined, name: string): boolean | undefined {
  const v = val(el, name);
  if (v === undefined) return undefined;
  return !['0', 'false', 'off', 'none'].includes(v);
}

export function textOf(el: XmlNode): string {
  if (typeof el === 'string') return el;
  return el.children.map(textOf).join('');
}
