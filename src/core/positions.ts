import { Position } from './types';

/** Computes the 0-based offset of the start of every line. */
export function computeLineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10 /* \n */) {
      starts.push(i + 1);
    } else if (ch === 13 /* \r */) {
      if (text.charCodeAt(i + 1) === 10) {
        i++;
      }
      starts.push(i + 1);
    }
  }
  return starts;
}

/** Converts an offset to a 1-based line/column position. */
export function positionAt(lineStarts: number[], offset: number): Position {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { line: low + 1, column: offset - lineStarts[low] + 1 };
}
