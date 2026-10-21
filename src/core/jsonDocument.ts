import { Node, ParseError, parseTree, printParseErrorCode } from 'jsonc-parser';
import { extractBindingExpressions } from './bindings';

export interface JsonSyntaxError {
  message: string;
  offset: number;
  length: number;
}

/** An `id` property found anywhere in the JSON document. */
export interface IdReference {
  /** The unescaped ID value (guaranteed non-empty). */
  value: string;
  /** JSON path such as `$.items[1].id`. */
  path: string;
  /** Offsets of the value *without* the surrounding quotes. */
  offset: number;
  length: number;
  node: Node;
  /**
   * JSON path of the container that holds this element (e.g. `$.body`).
   * Elements that share a container are siblings — only sibling elements
   * can be proven mutually exclusive through their visibility conditions.
   */
  containerPath: string;
  /** Raw `$when` value node of the owning element object, when present. */
  whenNode?: Node;
  /** Raw `isVisible` value node of the owning element object, when present. */
  isVisibleNode?: Node;
}

/** An Adaptive Card templating expression such as `${employee.name}` found in a string value. */
export interface BindingReference {
  /** The raw expression text between `${` and `}`. */
  expression: string;
  /** JSON path of the string value containing the expression. */
  path: string;
  /** Offsets of the full `${...}` span inside the document. */
  offset: number;
  length: number;
  /**
   * Enclosing `$data` repetition frames, outermost first. Each entry is the
   * raw `$data` value of an ancestor element (e.g. `${tasks}`). Empty when the
   * binding sits outside every repetition.
   */
  scopes: string[];
}

export interface ParsedQuickViewJson {
  root: Node | undefined;
  syntaxErrors: JsonSyntaxError[];
  ids: IdReference[];
  bindings: BindingReference[];
}

export interface JsonParseOptions {
  allowComments: boolean;
  allowTrailingCommas: boolean;
}

/**
 * Parses `quickview.json` with `jsonc-parser`, preserving source offsets.
 * Collects every `id` property (non-empty string values) and every `${...}`
 * templating expression found in any string value.
 */
export function parseQuickViewJson(text: string, options: JsonParseOptions): ParsedQuickViewJson {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowTrailingComma: options.allowTrailingCommas,
    disallowComments: !options.allowComments
  });

  const syntaxErrors: JsonSyntaxError[] = errors.map((e) => ({
    message: printParseErrorCode(e.error),
    offset: e.offset,
    length: Math.max(e.length, 1)
  }));

  const ids: IdReference[] = [];
  const bindings: BindingReference[] = [];
  if (root) {
    walk(root, '$', '$', text, ids, bindings, []);
  }

  return { root, syntaxErrors, ids, bindings };
}

function childPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${parent}.${key}` : `${parent}['${key}']`;
}

function walk(
  node: Node,
  path: string,
  containerPath: string,
  text: string,
  ids: IdReference[],
  bindings: BindingReference[],
  scopes: string[]
): void {
  switch (node.type) {
    case 'object': {
      // jsonc-parser represents object entries as `property` nodes whose
      // children are [keyNode, valueNode].
      let idRef: IdReference | undefined;
      let whenNode: Node | undefined;
      let isVisibleNode: Node | undefined;
      let dataNode: Node | undefined;
      for (const propertyNode of node.children ?? []) {
        if (propertyNode.type !== 'property') {
          continue;
        }
        const pair = propertyNode.children ?? [];
        const keyNode = pair[0];
        const valueNode = pair[1];
        if (!keyNode || !valueNode) {
          continue;
        }
        const key = typeof keyNode.value === 'string' ? keyNode.value : String(keyNode.value);
        if (key === '$data') {
          dataNode = valueNode;
        }
      }

      // An element carrying `$data` repeats once per collection item: its own
      // subtree (including `$when` / `isVisible` on the same object) is
      // evaluated in the new iteration scope. The `$data` value itself is
      // evaluated in the enclosing scope.
      const childScopes = dataNode ? [...scopes, rawDataExpression(dataNode)] : scopes;

      for (const propertyNode of node.children ?? []) {
        if (propertyNode.type !== 'property') {
          continue;
        }
        const pair = propertyNode.children ?? [];
        const keyNode = pair[0];
        const valueNode = pair[1];
        if (!keyNode || !valueNode) {
          continue;
        }
        const key = typeof keyNode.value === 'string' ? keyNode.value : String(keyNode.value);
        const valuePath = childPath(path, key);

        if (key === 'id' && valueNode.type === 'string' && typeof valueNode.value === 'string' && valueNode.value.length > 0) {
          // Skip the surrounding quotes when reporting the range.
          const quotedLength = Math.max(valueNode.length - 2, 0);
          idRef = {
            value: valueNode.value,
            path: `${valuePath}`,
            offset: valueNode.offset + 1,
            length: quotedLength,
            node: valueNode,
            containerPath
          };
          ids.push(idRef);
        } else if (key === '$when') {
          whenNode = valueNode;
        } else if (key === 'isVisible') {
          isVisibleNode = valueNode;
        }

        const nestedScopes = key === '$data' ? scopes : childScopes;
        // Children of this object are siblings within it.
        walk(valueNode, valuePath, path, text, ids, bindings, nestedScopes);
      }
      // Visibility properties may appear before or after `id` — attach them
      // once the whole element object has been seen.
      if (idRef) {
        idRef.whenNode = whenNode;
        idRef.isVisibleNode = isVisibleNode;
      }
      break;
    }
    case 'array': {
      const children = node.children ?? [];
      children.forEach((child, index) => walk(child, `${path}[${index}]`, path, text, ids, bindings, scopes));
      break;
    }
    case 'string': {
      // Bindings may appear in *any* string value, not only TextBlock.text.
      // Note: offsets assume the raw text matches the parsed value (no escapes);
      // escaped content inside a binding is an accepted, documented limitation.
      for (const match of extractBindingExpressions(String(node.value))) {
        bindings.push({
          expression: match.expression,
          path,
          offset: node.offset + 1 + match.start,
          length: match.length,
          scopes: [...scopes]
        });
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Normalizes a raw `$data` value node to expression text. The engine accepts
 * both `"${tasks}"` and the bare `"tasks"` form.
 */
function rawDataExpression(node: Node): string {
  if (node.type !== 'string') {
    return '';
  }
  const value = String(node.value).trim();
  const wrapped = /^\$\{([\s\S]*)\}$/.exec(value);
  return wrapped ? wrapped[1].trim() : value;
}
