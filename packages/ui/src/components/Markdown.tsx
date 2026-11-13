import { Fragment, type ReactNode } from "react";

/**
 * A small Markdown renderer for what chats write: headings, paragraphs, lists, quotes, code,
 * tables, bold, italic, inline code and links. It builds React elements only (no HTML is ever
 * inserted), so a message cannot inject markup. Links open only for http(s).
 */
export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return <div className={`md ${className}`}>{blocks(text.replace(/\r\n?/g, "\n"))}</div>;
}

/** A chat's message without the aitrack-report it ends with, and that report's text when there is one. */
export function splitReport(text: string): { text: string; report: string | null } {
  const fence = /```aitrack-report\s*\n([\s\S]*?)```/g;
  const fenced = [...text.matchAll(fence)];
  if (fenced.length > 0) {
    return { text: text.replace(fence, "").trim(), report: fenced.map((m) => m[1]!.trim()).join("\n") };
  }
  // An AI that forgot the fence: a JSON object with a task and a status.
  for (const o of jsonObjects(text).reverse()) {
    const v = o.value;
    if (typeof v.task === "string" && typeof v.status === "string") {
      let start = o.start;
      let end = o.end;
      // Take a ```json fence around it with it.
      const before = text.slice(0, start);
      const open = /```[a-z-]*\s*\n?\s*$/i.exec(before);
      const close = /^\s*```/.exec(text.slice(end));
      if (open && close) {
        start = open.index;
        end += close[0].length;
      }
      return { text: (text.slice(0, start) + text.slice(end)).trim(), report: text.slice(o.start, o.end) };
    }
  }
  return { text, report: null };
}

function jsonObjects(text: string): Array<{ start: number; end: number; value: Record<string, unknown> }> {
  const out: Array<{ start: number; end: number; value: Record<string, unknown> }> = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (c === "\\") j++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        end = j + 1;
        break;
      }
    }
    if (end < 0) break;
    try {
      const value = JSON.parse(text.slice(i, end)) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        out.push({ start: i, end, value: value as Record<string, unknown> });
        i = end - 1;
      }
    } catch {
      // Not JSON.
    }
  }
  return out;
}

const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function blocks(text: string): ReactNode[] {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    // Fenced code.
    const fence = /^\s*(```+|~~~+)\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      i++;
      out.push(
        <pre key={key++}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1]!.length + 2);
      const H = `h${level}` as "h3" | "h4" | "h5" | "h6";
      out.push(<H key={key++}>{inline(heading[2]!)}</H>);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push(<hr key={key++} />);
      i++;
      continue;
    }
    // Table: a header row, a separator row, then rows.
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push(
        <div className="md-table" key={key++}>
          <table>
            <thead>
              <tr>
                {head.map((c, n) => (
                  <th key={n}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, n) => (
                <tr key={n}>
                  {head.map((_, m) => (
                    <td key={m}>{inline(r[m] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push(<blockquote key={key++}>{blocks(body.join("\n"))}</blockquote>);
      continue;
    }
    if (LIST.test(line)) {
      const items: Array<{ indent: number; ordered: boolean; text: string }> = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i]!);
        if (m) {
          items.push({ indent: m[1]!.replace(/\t/g, "  ").length, ordered: /\d/.test(m[2]!), text: m[3]! });
          i++;
        } else if (lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && items.length > 0) {
          // A wrapped line of the item above.
          items[items.length - 1]!.text += `\n${lines[i]!.trim()}`;
          i++;
        } else break;
      }
      out.push(<Fragment key={key++}>{list(items)}</Fragment>);
      continue;
    }
    // A paragraph: lines until a blank line or another block. Line breaks are kept, as in a chat.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !LIST.test(lines[i]!) &&
      !HEADING.test(lines[i]!) &&
      !/^\s*(```|~~~|>)/.test(lines[i]!) &&
      !(lines[i]!.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!))
    ) {
      para.push(lines[i++]!);
    }
    out.push(<p key={key++}>{withBreaks(para)}</p>);
  }
  return out;
}

function withBreaks(lines: string[]): ReactNode[] {
  return lines.map((l, n) => (
    <Fragment key={n}>
      {n > 0 && <br />}
      {inline(l.trim())}
    </Fragment>
  ));
}

/** Nested lists by indentation. */
function list(items: Array<{ indent: number; ordered: boolean; text: string }>): ReactNode {
  const base = items[0]?.indent ?? 0;
  const ordered = items[0]?.ordered ?? false;
  const nodes: ReactNode[] = [];
  let n = 0;
  while (n < items.length) {
    const item = items[n]!;
    const children: typeof items = [];
    n++;
    while (n < items.length && items[n]!.indent > base) children.push(items[n++]!);
    nodes.push(
      <li key={nodes.length}>
        {withBreaks(item.text.split("\n"))}
        {children.length > 0 && list(children)}
      </li>,
    );
  }
  return ordered ? <ol>{nodes}</ol> : <ul>{nodes}</ul>;
}

const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|__([^_]+?)__|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"`])|(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])|(?<![\w])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w])|~~([^~]+?)~~/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (m[1]) out.push(<code key={key++}>{m[2]}</code>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={key++}>{inline(m[3] ?? m[4]!)}</strong>);
    else if (m[5] !== undefined)
      out.push(
        <a key={key++} href={m[6]} target="_blank" rel="noreferrer">
          {inline(m[5])}
        </a>,
      );
    else if (m[7] !== undefined)
      out.push(
        <a key={key++} href={m[7]} target="_blank" rel="noreferrer">
          {m[7]}
        </a>,
      );
    else if (m[8] !== undefined || m[9] !== undefined) out.push(<em key={key++}>{inline(m[8] ?? m[9]!)}</em>);
    else if (m[10] !== undefined) out.push(<del key={key++}>{inline(m[10])}</del>);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
