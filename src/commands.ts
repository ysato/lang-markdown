import {ChangeSpec, EditorSelection, StateCommand, Text} from "@codemirror/state"
import {syntaxTree} from "@codemirror/language"
import {SyntaxNode} from "@lezer/common"
import {markdownLanguage} from "./markdown"

class Context {
  constructor(
    readonly node: SyntaxNode,
    readonly from: number,
    readonly to: number,
    readonly spaceBefore: string,
    readonly spaceAfter: string,
    readonly type: string,
    readonly item: SyntaxNode | null
  ) {}

  blank(maxWidth: number | null, trailing = true) {
    let result = this.spaceBefore
    if (maxWidth != null) {
      while (result.length < maxWidth) result += " "
      return result
    } else {
      for (let i = this.to - this.from - result.length - this.spaceAfter.length; i > 0; i--) result += " "
      return result + (trailing ? this.spaceAfter : "")
    }
  }

  marker(doc: Text, add: number) {
    let number = this.node.name == "OrderedList" ? '1' : ""
    return this.spaceBefore + number + this.type + this.spaceAfter
  }
}

function getContext(node: SyntaxNode, doc: Text) {
  let nodes = []
  for (let cur: SyntaxNode | null = node; cur && cur.name != "Document"; cur = cur.parent) {
    if (cur.name == "ListItem")
      nodes.push(cur)
  }
  let context = []
  for (let i = nodes.length - 1; i >= 0; i--) {
    let node = nodes[i], match
    let line = doc.lineAt(node.from), startPos = node.from - line.from
    if (node.name == "ListItem" && node.parent!.name == "OrderedList" &&
               (match = /^([ \t]*)\d+([.)])([ \t]*)/.exec(line.text.slice(startPos)))) {
      let after = match[3], len = match[0].length
      if (after.length >= 4) { after = after.slice(0, after.length - 4); len -= 4 }
      context.push(new Context(node.parent!, startPos, startPos + len, match[1], after, match[2], node))
    } else if (node.name == "ListItem" && node.parent!.name == "BulletList" &&
               (match = /^([ \t]*)([-+*])([ \t]{1,4}\[[ xX]\])?([ \t]+)/.exec(line.text.slice(startPos)))) {
      let after = match[4], len = match[0].length
      if (after.length > 4) { after = after.slice(0, after.length - 4); len -= 4 }
      let type = match[2]
      if (match[3]) type += match[3].replace(/[xX]/, ' ')
      context.push(new Context(node.parent!, startPos, startPos + len, match[1], after, type, node))
    }
  }
  return context
}

/// This command, when invoked in Markdown context with cursor
/// selection(s), will create a new line with the markup for
/// blockquotes and lists that were active on the old line. If the
/// cursor was directly after the end of the markup for the old line,
/// trailing whitespace and list markers are removed from that line.
///
/// The command does nothing in non-Markdown context, so it should
/// not be used as the only binding for Enter (even in a Markdown
/// document, HTML and code regions might use a different language).
export const insertNewlineContinueMarkup: StateCommand = ({state, dispatch}) => {
  let tree = syntaxTree(state), {doc} = state
  let dont = null, changes = state.changeByRange(range => {
    if (!range.empty || !markdownLanguage.isActiveAt(state, range.from)) return dont = {range}
    let pos = range.from, line = doc.lineAt(pos)
    let context = getContext(tree.resolveInner(pos, -1), doc)
    while (context.length && context[context.length - 1].from > pos - line.from) context.pop()
    if (!context.length) return dont = {range}
    let inner = context[context.length - 1]
    if (inner.to - inner.spaceAfter.length > pos - line.from) return dont = {range}

    let emptyLine = pos >= (inner.to - inner.spaceAfter.length) && !/\S/.test(line.text.slice(inner.to))
    // Empty line in list
    if (inner.item && emptyLine) {
      // First list item or blank line before: delete a level of markup
      if (inner.node.firstChild!.to >= pos ||
          line.from > 0 && !/[^\s>]/.test(doc.lineAt(line.from - 1).text)) {
        let next = context.length > 1 ? context[context.length - 2] : null
        let delTo, insert = ""
        if (next && next.item) { // Re-add marker for the list at the next level
          delTo = line.from + next.from
          insert = next.marker(doc, 1)
        } else {
          delTo = line.from + (next ? next.to : 0)
        }
        let changes: ChangeSpec[] = [{from: delTo, to: pos, insert}]
        return {range: EditorSelection.cursor(delTo + insert.length), changes}
      } else { // Move this line down
        let insert = state.lineBreak;
        return {
          range: EditorSelection.cursor(line.from + insert.length),
          changes: [{ from: line.from, to: line.to, insert }]
        };
      }
    }

    let changes: ChangeSpec[] = []
    let continued = inner.item && inner.item.from < line.from
    let insert = ""
    // If not dedented
    if (!continued || /^[\s\d.)\-+*>]*/.exec(line.text)![0].length >= inner.to) {
      for (let i = 0, e = context.length - 1; i <= e; i++) {
        insert += i == e && !continued ? context[i].marker(doc, 1)
          : context[i].blank(i < e ? context[i + 1].from - insert.length : null)
      }
    }
    let from = pos
    while (from > line.from && /\s/.test(line.text.charAt(from - line.from - 1))) from--
    insert = state.lineBreak + insert
    changes.push({from, to: pos, insert})
    return {range: EditorSelection.cursor(from + insert.length), changes}
  })
  if (dont) return false
  dispatch(state.update(changes, {scrollIntoView: true, userEvent: "input"}))
  return true
}
