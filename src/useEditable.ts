import { RefObject, useReducer, useRef, useLayoutEffect } from 'react';

interface State {
  position: number;
  content: string;
}

type ChangeHandler = (text: string) => void;

const observerSettings = {
  characterData: true,
  characterDataOldValue: true,
  childList: true,
  subtree: true,
};

const isUndoRedoKey = (event: KeyboardEvent): boolean =>
  (event.metaKey || event.ctrlKey) && event.code === 'KeyZ';

const toString = (element: HTMLElement): string => {
  const queue: Node[] = [element.firstChild!];

  let content = '';
  let node: Node;
  while ((node = queue.pop()!)) {
    if (node.nodeType === Node.TEXT_NODE) {
      content += node.nodeValue;
    } else if (node.nodeType === Node.ELEMENT_NODE && node.nodeName === 'BR') {
      content += '\n';
    }

    if (node.nextSibling) queue.push(node.nextSibling);
    if (node.firstChild) queue.push(node.firstChild);
  }

  // contenteditable Quirk: Without plaintext-only a pre/pre-wrap element must always
  // end with at least one newline character
  if (content[content.length - 1] !== '\n') content += '\n';

  return content;
};

const getPosition = (element: HTMLElement): number => {
  const selection = window.getSelection()!;
  const queue: Node[] = [element.firstChild!];

  // Without plaintext-only mode we may get a node and an offset of one of its children
  // if the selection happens to land in-between nodes
  let { focusNode, focusOffset } = selection;
  if (focusNode && focusNode.nodeType !== Node.TEXT_NODE) {
    if (focusOffset <= focusNode.childNodes.length - 1)
      focusNode = focusNode.childNodes[focusOffset];
    focusOffset = 0;
  }

  let position = 0;
  let node: Node | void;
  while ((node = queue.pop()!)) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node === focusNode) return position + focusOffset;
      position += node.nodeValue!.length;
    } else if (node.nodeType === Node.ELEMENT_NODE && node.nodeName === 'BR') {
      position++;
    }

    if (node.nextSibling && node !== focusNode) queue.push(node.nextSibling);
    if (node.firstChild) queue.push(node.firstChild);
  }

  return position;
};

const setPosition = (element: HTMLElement, position: number): void => {
  const selection = window.getSelection()!;
  const queue: Node[] = [element.firstChild!];
  const range = new Range();

  let current = 0;

  let node: Node;
  while ((node = queue.pop()!)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.nodeValue!.length;
      if (current + length >= position) {
        const offset = position - current;
        if (offset === length) {
          range.setStartAfter(node);
        } else {
          range.setStart(node, offset);
        }
        break;
      }

      current += node.nodeValue!.length;
    } else if (node.nodeType === Node.ELEMENT_NODE && node.nodeName === 'BR') {
      if (current + 1 >= position) {
        range.setStartAfter(node);
        break;
      }

      current++;
    }

    if (node.nextSibling) queue.push(node.nextSibling);
    if (node.firstChild) queue.push(node.firstChild);
  }

  selection.removeAllRanges();
  selection.addRange(range);
};

interface Options {
  disabled?: boolean;
}

export const useEditable = (
  elementRef: RefObject<HTMLElement>,
  onChange: ChangeHandler,
  opts?: Options
) => {
  if (typeof navigator !== 'object') return;
  if (!opts) opts = {};

  const unblock = useReducer(x => x + 1, 0)[1];
  const onChangeRef = useRef(onChange);
  const positionRef = useRef(-1);
  const statesRef = useRef<State[]>([]);
  const stateAtRef = useRef(-1);
  const queueRef = useRef<MutationRecord[]>([]);
  const addMutationsToQueue = (list: MutationRecord[]) => {
    for (let i = 0; i < list.length; i++) queueRef.current.push(list[i]);
  };

  const disconnectedRef = useRef(false);
  const observerRef = useRef(new MutationObserver(addMutationsToQueue));

  onChangeRef.current = onChange;

  useLayoutEffect(() => {
    if (!elementRef.current || opts!.disabled) return;

    disconnectedRef.current = false;
    observerRef.current.observe(elementRef.current, observerSettings);
    if (positionRef.current >= 0) {
      setPosition(elementRef.current, positionRef.current);
    }

    return () => {
      observerRef.current.disconnect();
    };
  });

  useLayoutEffect(() => {
    if (!elementRef.current || opts!.disabled) {
      statesRef.current.length = 0;
      stateAtRef.current = -1;
      return;
    }

    const element = elementRef.current!;
    if (positionRef.current > -1) {
      element.focus();
      setPosition(element, positionRef.current);
    }

    const prevWhiteSpace = element.style.whiteSpace;
    const prevContentEditable = element.contentEditable;
    let hasPlaintextSupport = true;
    try {
      // Firefox and IE11 do not support plaintext-only mode
      element.contentEditable = 'plaintext-only';
    } catch (_error) {
      element.contentEditable = 'true';
      hasPlaintextSupport = false;
    }

    if (prevWhiteSpace !== 'pre') element.style.whiteSpace = 'pre-wrap';

    let _trackStateTimestamp: number;
    const trackState = (ignoreTimestamp?: boolean) => {
      if (!elementRef.current || positionRef.current === -1) return;

      const { current: states } = statesRef;
      const content = toString(element);
      const position = getPosition(element);
      const timestamp = new Date().valueOf();

      // Prevent recording new state in list if last one has been new enough
      const lastState = states[stateAtRef.current];
      if (
        (!ignoreTimestamp && timestamp - _trackStateTimestamp < 500) ||
        (lastState && lastState.content === content)
      ) {
        _trackStateTimestamp = timestamp;
        return;
      }

      const at = ++stateAtRef.current;
      states[at] = { content, position };
      states.splice(at + 1);
      if (at > 500) {
        stateAtRef.current--;
        states.shift();
      }
    };

    const flushChanges = () => {
      addMutationsToQueue(observerRef.current.takeRecords());
      if (queueRef.current.length > 0) {
        const content = toString(element);
        positionRef.current = getPosition(element);
        observerRef.current.disconnect();
        disconnectedRef.current = true;

        let mutation: MutationRecord | void;
        let i = 0;
        while ((mutation = queueRef.current.pop())) {
          if (mutation.oldValue !== null)
            mutation.target.textContent = mutation.oldValue;
          for (i = mutation.removedNodes.length - 1; i >= 0; i--)
            mutation.target.insertBefore(
              mutation.removedNodes[i],
              mutation.nextSibling
            );
          for (i = mutation.addedNodes.length - 1; i >= 0; i--)
            mutation.target.removeChild(mutation.addedNodes[i]);
        }

        onChangeRef.current(content);
      }
    };

    const onKeyDown = (event: HTMLElementEventMap['keydown']) => {
      if (event.defaultPrevented) {
        return;
      } else if (disconnectedRef.current) {
        // React Quirk: It's expected that we may lose events while disconnected, which is why
        // we'd like to block some inputs if they're unusually fast. However, this always
        // coincides with React not executing the update immediately and then getting stuck,
        // which can be prevented by issuing a dummy state change.
        event.preventDefault();
        return unblock();
      }

      if (isUndoRedoKey(event)) {
        event.preventDefault();

        let state: State;
        if (!event.shiftKey) {
          const at = --stateAtRef.current;
          state = statesRef.current[at];
          if (!state) stateAtRef.current = 0;
        } else {
          const at = ++stateAtRef.current;
          state = statesRef.current[at];
          if (!state) stateAtRef.current = statesRef.current.length - 1;
        }

        if (state) {
          positionRef.current = state.position;
          onChangeRef.current(state.content);
        }
        return;
      } else {
        trackState();
      }

      // Firefox Quirks: Firefox insists on adding <br> tags since it doesn't support
      // plaintext-only mode and doesn't immediately normalize duplicate text nodes
      if (!hasPlaintextSupport && event.key === 'Enter') {
        event.preventDefault();
        document.execCommand('insertHTML', false, '\r\n');
        element.normalize();
        flushChanges();
      } else if (!hasPlaintextSupport && event.key === 'Backspace') {
        element.normalize();
      }
    };

    const onKeyUp = (event: HTMLElementEventMap['keyup']) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (!isUndoRedoKey(event)) trackState();
      flushChanges();
      // Chrome Quirk: The contenteditable may lose focus after the first edit or so
      element.focus();
    };

    const onFocus = () => {
      positionRef.current = getPosition(element);
    };

    const onBlur = () => {
      positionRef.current = -1;
    };

    const onPaste = (event: HTMLElementEventMap['paste']) => {
      event.preventDefault();
      trackState(true);
      const text = event
        .clipboardData!.getData('text/plain')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
      document.execCommand('insertHTML', false, text);
      element.normalize();
      trackState(true);
      flushChanges();
    };

    element.addEventListener('focus', onFocus);
    element.addEventListener('blur', onBlur);
    element.addEventListener('paste', onPaste);
    element.addEventListener('keydown', onKeyDown);
    element.addEventListener('keyup', onKeyUp);

    return () => {
      element.removeEventListener('focus', onFocus);
      element.removeEventListener('blur', onBlur);
      element.removeEventListener('paste', onPaste);
      element.removeEventListener('keydown', onKeyDown);
      element.removeEventListener('keyup', onKeyUp);
      element.style.whiteSpace = prevWhiteSpace;
      element.contentEditable = prevContentEditable;
    };
  }, [elementRef.current!, opts!.disabled]);
};
