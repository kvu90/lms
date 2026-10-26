import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { richTextDocumentSchema, type RichTextDocument } from '@lms/contracts';
import { contentForSave, ensureTerminalContinuation } from './document-continuation.js';
import { RichTextEditor } from './RichTextEditor.js';
import { RichTextView } from './RichTextView.js';
import {
  MULTIPLE_CHOICE_COUNT,
  composeMultipleChoiceDocument,
  createEmptyMultipleChoiceDocument,
  isCompleteMultipleChoice,
  splitMultipleChoiceDocument,
  type MultipleChoiceDocumentJson,
} from './multiple-choice.js';
import { MultipleChoiceEditor } from './MultipleChoiceEditor.js';
import {
  TRUE_FALSE_STATEMENT_COUNT,
  composeTrueFalseDocument,
  createEmptyTrueFalseDocument,
  getTrueFalseStatementIds,
  isCompleteTrueFalse,
  splitTrueFalseDocument,
} from './true-false.js';
import { TrueFalseEditor } from './TrueFalseEditor.js';

/**
 * Đưa editor vào trạng thái active bằng cách focus vùng soạn — từ lát
 * E3 toolbar chỉ hiện cho editor đang active, nên các ca bấm nút
 * toolbar phải focus trước như người dùng thật.
 */
async function focusEditor(container: HTMLElement): Promise<void> {
  const editable = container.querySelector('.ProseMirror');
  expect(editable).not.toBeNull();
  fireEvent.focus(editable as Element);
  await screen.findByRole('button', { name: 'Hoàn tác' });
}

afterEach(() => {
  cleanup();
});

/**
 * Spec của package editor: trình hiển thị chỉ-đọc phải dựng đúng HTML của
 * lát văn bản thuần (paragraph + mark đậm), tài liệu rỗng không gây lỗi.
 * (Rà soát #219: ca liệt kê danh sách extension nội bộ đã bỏ — đó là chi
 * tiết triển khai; luật "chỉ lát văn bản thuần" được khẳng định ở tầng
 * nghiệp vụ bởi e2e question-types-stimulus: tài liệu ngoài lát bị từ chối.)
 */
describe('RichTextView', () => {
  it('renders a paragraph with bold text to HTML', () => {
    const document: RichTextDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Xin chào ' },
            { type: 'text', text: 'Lão gia', marks: [{ type: 'bold' }] },
          ],
        },
      ],
    };

    const { container } = render(<RichTextView value={document} />);

    const paragraph = container.querySelector('p');
    expect(paragraph).not.toBeNull();
    expect(paragraph).toHaveTextContent('Xin chào Lão gia');
    expect(container.querySelector('strong')).toHaveTextContent('Lão gia');
  });

  it('renders nothing for a null document without crashing', () => {
    const { container } = render(<RichTextView value={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an empty document without crashing', () => {
    const document: RichTextDocument = {
      type: 'doc',
      content: [{ type: 'paragraph' }],
    };

    const { container } = render(<RichTextView value={document} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders inline and block math with KaTeX from the saved document', () => {
    const document: RichTextDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Cho hàm số ' },
            { type: 'inlineMath', attrs: { latex: 'y = ax + b' } },
            { type: 'text', text: ' với hệ số:' },
          ],
        },
        { type: 'blockMath', attrs: { latex: '\\frac{a}{b}' } },
      ],
    };

    const { container } = render(<RichTextView value={document} />);

    const inline = container.querySelector('[data-type="inline-math"]');
    expect(inline).not.toBeNull();
    expect(inline?.getAttribute('data-latex')).toBe('y = ax + b');
    expect(inline?.querySelector('.katex')).not.toBeNull();
    const block = container.querySelector('[data-type="block-math"]');
    expect(block).not.toBeNull();
    expect(block?.getAttribute('data-latex')).toBe('\\frac{a}{b}');
    expect(block?.querySelector('.katex')).not.toBeNull();
  });

  it('renders a bullet list with its items', () => {
    const document: RichTextDocument = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Mục thứ nhất' }] },
              ],
            },
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Mục thứ hai' }] },
                { type: 'blockMath', attrs: { latex: 'x^2' } },
              ],
            },
          ],
        },
      ],
    };

    const { container } = render(<RichTextView value={document} />);

    const items = container.querySelectorAll('ul > li');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Mục thứ nhất');
    expect(items[1]).toHaveTextContent('Mục thứ hai');
    expect(items[1]?.querySelector('[data-type="block-math"] .katex')).not.toBeNull();
  });

  it('renders an image with its durable src and alt text', () => {
    const document: RichTextDocument = {
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: { src: '/api/v1/files/abc-123/content', alt: 'Đồ thị hàm số' },
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Quan sát đồ thị.' }] },
      ],
    };

    const { container } = render(<RichTextView value={document} />);

    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    expect(image?.getAttribute('src')).toBe('/api/v1/files/abc-123/content');
    expect(image?.getAttribute('alt')).toBe('Đồ thị hàm số');
  });
});

/**
 * Luồng soạn thảo phía {@link RichTextEditor}: người soạn dùng đúng các
 * nút/panel mà giao diện thật cung cấp (không chạm vào nội bộ Tiptap),
 * tài liệu sinh ra qua `onChange` là thứ sẽ được lưu — các ca này khoá
 * hành vi nghiệp vụ của editor: chèn được công thức/danh sách/ảnh, sửa
 * được công thức đã chèn, và LaTeX sai thì bị chặn, không lọt vào tài
 * liệu đã lưu.
 */
describe('RichTextEditor', () => {
  /** Thu thập mọi tài liệu editor phát qua onChange, mới nhất ở cuối. */
  function collectChanges() {
    const changes: RichTextDocument[] = [];
    return {
      changes,
      onChange: (document: RichTextDocument) => {
        changes.push(document);
      },
      lastChange: () => changes[changes.length - 1],
    };
  }

  it('inserts an inline math node through the LaTeX panel', async () => {
    const { onChange, lastChange } = collectChanges();
    const { container } = render(<RichTextEditor onChange={onChange} />);
    await focusEditor(container);

    fireEvent.click(screen.getByRole('button', { name: 'Chèn công thức' }));
    fireEvent.change(screen.getByLabelText('Mã LaTeX'), {
      target: { value: 'x^2 + y^2 = z^2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Xong' }));

    await waitFor(() => {
      expect(lastChange()).toBeDefined();
    });
    const paragraph = lastChange()?.content[0];
    expect(paragraph?.type).toBe('paragraph');
    if (paragraph?.type === 'paragraph') {
      expect(paragraph.content).toContainEqual({
        type: 'inlineMath',
        attrs: { latex: 'x^2 + y^2 = z^2' },
      });
    }
    // Tài liệu editor sinh ra phải qua được hợp đồng contracts ở biên.
    expect(richTextDocumentSchema.parse(lastChange())).toEqual(lastChange());
    expect(screen.queryByTestId('math-panel')).toBeNull();
  });

  it('inserts a block math node when the panel toggle is on', async () => {
    const { onChange, lastChange } = collectChanges();
    const { container } = render(<RichTextEditor onChange={onChange} />);
    await focusEditor(container);

    fireEvent.click(screen.getByRole('button', { name: 'Chèn công thức' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tách dòng' }));
    fireEvent.change(screen.getByLabelText('Mã LaTeX'), {
      target: { value: '\\int_0^1 x \\, dx' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Xong' }));

    await waitFor(() => {
      expect(lastChange()).toBeDefined();
    });
    expect(lastChange()?.content).toContainEqual({
      type: 'blockMath',
      attrs: { latex: '\\int_0^1 x \\, dx' },
    });
  });

  it('blocks saving invalid LaTeX and keeps the panel open with an error', async () => {
    const { onChange, changes } = collectChanges();
    const { container } = render(<RichTextEditor onChange={onChange} />);
    await focusEditor(container);

    fireEvent.click(screen.getByRole('button', { name: 'Chèn công thức' }));
    fireEvent.change(screen.getByLabelText('Mã LaTeX'), {
      target: { value: '\\frac{1}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Xong' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/KaTeX|Parse|Error/i);
    expect(screen.getByTestId('math-panel')).toBeInTheDocument();
    const savedMath = JSON.stringify(changes);
    expect(savedMath).not.toContain('inlineMath');
    expect(savedMath).not.toContain('blockMath');
  });

  it('reopens the panel on double-click and updates the existing formula', async () => {
    const initial: RichTextDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Tổng: ' },
            { type: 'inlineMath', attrs: { latex: 'a + b' } },
          ],
        },
      ],
    };
    const { onChange, lastChange } = collectChanges();
    const { container } = render(<RichTextEditor value={initial} onChange={onChange} />);

    const mathElement = container.querySelector('[data-type="inline-math"]');
    expect(mathElement).not.toBeNull();
    fireEvent.doubleClick(mathElement as Element);

    const input = (await screen.findByLabelText('Mã LaTeX')) as HTMLInputElement;
    expect(input.value).toBe('a + b');
    fireEvent.change(input, { target: { value: 'a + c' } });
    fireEvent.click(screen.getByRole('button', { name: 'Xong' }));

    await waitFor(() => {
      expect(JSON.stringify(lastChange())).toContain('a + c');
    });
    const paragraph = lastChange()?.content[0];
    if (paragraph?.type === 'paragraph') {
      expect(paragraph.content).toContainEqual({
        type: 'inlineMath',
        attrs: { latex: 'a + c' },
      });
      expect(paragraph.content).not.toContainEqual({
        type: 'inlineMath',
        attrs: { latex: 'a + b' },
      });
    }
  });

  it('turns the current paragraph into a bullet list from the toolbar', async () => {
    const initial: RichTextDocument = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Mục cần liệt kê' }] },
      ],
    };
    const { onChange, lastChange } = collectChanges();
    const { container } = render(<RichTextEditor value={initial} onChange={onChange} />);
    await focusEditor(container);

    fireEvent.click(screen.getByRole('button', { name: 'Danh sách không thứ tự' }));

    await waitFor(() => {
      expect(lastChange()?.content[0]?.type).toBe('bulletList');
    });
  });

  it('inserts an image through the host onRequestImage callback', async () => {
    const onRequestImage = vi.fn(async () => ({
      src: '/api/v1/files/abc-123/content',
      alt: 'Đồ thị hàm số',
    }));
    const { onChange, lastChange } = collectChanges();
    const { container } = render(
      <RichTextEditor onChange={onChange} onRequestImage={onRequestImage} />,
    );
    await focusEditor(container);

    fireEvent.click(screen.getByRole('button', { name: 'Chèn ảnh' }));

    await waitFor(() => {
      expect(lastChange()?.content).toContainEqual({
        type: 'image',
        attrs: { src: '/api/v1/files/abc-123/content', alt: 'Đồ thị hàm số', title: null },
      });
    });
    // Node ảnh không được mang thuộc tính ngoài hợp đồng (width/height
    // của extension gốc) — schema strictObject sẽ từ chối ở biên API.
    expect(richTextDocumentSchema.parse(lastChange())).toEqual(lastChange());
    expect(onRequestImage).toHaveBeenCalledTimes(1);
  });

  it('hides the image button when the host provides no image callback', async () => {
    const { container } = render(<RichTextEditor />);
    await focusEditor(container);

    expect(screen.queryByRole('button', { name: 'Chèn ảnh' })).toBeNull();
  });

  it('shows the toolbar only while the editor is active (focused)', async () => {
    const { container } = render(<RichTextEditor />);

    // Chưa focus: không toolbar nào — trước lát E3 toolbar luôn hiện
    // trên mọi editor của form.
    expect(screen.queryByRole('toolbar')).toBeNull();

    await focusEditor(container);
    expect(screen.getByRole('toolbar')).toBeInTheDocument();

    // Tương tác ra ngoài editor: toolbar ẩn đi.
    fireEvent.pointerDown(document.body);
    await waitFor(() => {
      expect(screen.queryByRole('toolbar')).toBeNull();
    });
  });

  it('keeps a single toolbar for the focused editor when several editors share a page', async () => {
    const first = render(<RichTextEditor ariaLabel="Trường một" />);
    const second = render(<RichTextEditor ariaLabel="Trường hai" />);

    await focusEditor(first.container);
    expect(screen.getAllByRole('toolbar')).toHaveLength(1);

    await focusEditor(second.container);
    expect(screen.getAllByRole('toolbar')).toHaveLength(1);
  });

  it('undoes and redoes an insertion from the toolbar (Hoàn tác / Làm lại)', async () => {
    const { onChange, lastChange } = collectChanges();
    const { container } = render(<RichTextEditor onChange={onChange} />);
    await focusEditor(container);

    // Chưa có gì để hoàn tác: cả hai nút đều disabled theo can().
    expect(screen.getByRole('button', { name: 'Hoàn tác' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Làm lại' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Chèn công thức' }));
    fireEvent.change(screen.getByLabelText('Mã LaTeX'), {
      target: { value: 'a + b' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Xong' }));
    await waitFor(() => {
      expect(JSON.stringify(lastChange())).toContain('inlineMath');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Hoàn tác' }));
    await waitFor(() => {
      expect(JSON.stringify(lastChange())).not.toContain('inlineMath');
    });
    expect(screen.getByRole('button', { name: 'Làm lại' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Làm lại' }));
    await waitFor(() => {
      expect(JSON.stringify(lastChange())).toContain('inlineMath');
    });
  });

  it('saves a document ending in a block formula without the technical trailing paragraph', async () => {
    const { onChange, lastChange } = collectChanges();
    const { container } = render(<RichTextEditor onChange={onChange} />);
    await focusEditor(container);

    fireEvent.click(screen.getByRole('button', { name: 'Chèn công thức' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tách dòng' }));
    fireEvent.change(screen.getByLabelText('Mã LaTeX'), {
      target: { value: 'x^2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Xong' }));

    await waitFor(() => {
      expect(lastChange()?.content.at(-1)?.type).toBe('blockMath');
    });
    expect(richTextDocumentSchema.parse(lastChange())).toEqual(lastChange());
  });
});

/**
 * Vệ sinh tài liệu (lát E3, theo `contentForSave`/`ensureTerminal
 * Continuations` của giaokhoa): paragraph tiếp nối sau block nguyên tử
 * là hạ tầng soạn thảo, không phải nội dung — dạng đem lưu phải dọn nó,
 * dạng nạp vào phải có nó để người soạn viết tiếp được.
 */
describe('document continuation helpers', () => {
  it('strips only the empty continuation paragraph after a trailing atomic block', () => {
    const document: RichTextDocument = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Đề bài' }] },
        { type: 'blockMath', attrs: { latex: 'x^2' } },
        { type: 'paragraph' },
      ],
    };

    expect(contentForSave(document).content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Đề bài' }] },
      { type: 'blockMath', attrs: { latex: 'x^2' } },
    ]);
  });

  it('keeps a trailing empty paragraph that does not follow an atomic block', () => {
    const document: RichTextDocument = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Đề bài' }] },
        { type: 'paragraph' },
      ],
    };

    expect(contentForSave(document).content).toHaveLength(2);
  });

  it('appends a continuation paragraph when loading a document ending in an atomic block', () => {
    const document: RichTextDocument = {
      type: 'doc',
      content: [{ type: 'blockMath', attrs: { latex: 'x^2' } }],
    };

    expect(ensureTerminalContinuation(document).content).toEqual([
      { type: 'blockMath', attrs: { latex: 'x^2' } },
      { type: 'paragraph' },
    ]);
    // Đã có paragraph chốt đuôi thì giữ nguyên tham chiếu.
    const withParagraph: RichTextDocument = {
      type: 'doc',
      content: [
        { type: 'blockMath', attrs: { latex: 'x^2' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'tiếp' }] },
      ],
    };
    expect(ensureTerminalContinuation(withParagraph)).toBe(withParagraph);
  });
});

/**
 * Spec của editor trắc nghiệm thống nhất (lát P4 #248): các ca kiểm
 * LUỒNG SOẠN–TÁCH–LẮP của mô hình giaokhoa — soạn trên một tài liệu
 * (thân câu + lựa chọn), đáp án đúng là id nằm ngoài tài liệu, khi
 * tách để lưu thì thân câu không còn node lựa chọn và thứ tự lựa
 * chọn trong tài liệu là thứ tự đáp án. Đổi ngược mô hình (đáp án
 * đúng nằm trong nội dung lựa chọn, thân câu còn choiceList khi lưu)
 * thì các ca này phải đỏ.
 */
describe('MultipleChoice authoring document', () => {
  const textDoc = (text: string): RichTextDocument => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

  it('creates an empty document with exactly four identified choices', () => {
    const document = createEmptyMultipleChoiceDocument();
    const { question, choices } = splitMultipleChoiceDocument(document);

    expect(question.content).toHaveLength(1);
    expect(choices).toHaveLength(MULTIPLE_CHOICE_COUNT);
    expect(new Set(choices.map((choice) => choice.attrs.id)).size).toBe(MULTIPLE_CHOICE_COUNT);
    expect(isCompleteMultipleChoice(document, choices[0]?.attrs.id)).toBe(false);
  });

  it('composes a question view into a unified document and splits it back losslessly', () => {
    const answers = [
      { id: 'ans-2', answer: textDoc('Phương án B'), sortOrder: 2 },
      { id: 'ans-1', answer: textDoc('Phương án A'), sortOrder: 1 },
      { id: 'ans-3', answer: textDoc('Phương án C'), sortOrder: 3 },
      { id: 'ans-4', answer: textDoc('Phương án D'), sortOrder: 4 },
    ];
    const document = composeMultipleChoiceDocument(textDoc('Thủ đô của Việt Nam?'), answers);
    const { question, choices } = splitMultipleChoiceDocument(document);

    // Thân câu sau khi tách là tài liệu hợp đồng thuần: không còn
    // node choice/choiceList nào (bất biến của quyết 12:12).
    expect(JSON.stringify(question)).not.toContain('choice');
    expect(question.content?.[0]?.content?.[0]?.text).toBe('Thủ đô của Việt Nam?');
    // Thứ tự đáp án khi tách = thứ tự sortOrder đã lắp vào.
    expect(choices.map((choice) => choice.attrs.id)).toEqual(['ans-1', 'ans-2', 'ans-3', 'ans-4']);
    expect(choices[0]?.content?.[0]?.content?.[0]?.text).toBe('Phương án A');
    expect(isCompleteMultipleChoice(document, 'ans-1')).toBe(true);
    expect(isCompleteMultipleChoice(document, 'khong-ton-tai')).toBe(false);
    expect(isCompleteMultipleChoice(document, undefined)).toBe(false);
  });

  it('keeps the answer order equal to the document order after a reorder', () => {
    const answers = [1, 2, 3, 4].map((n) => ({
      id: `ans-${n}`,
      answer: textDoc(`Phương án ${n}`),
      sortOrder: n,
    }));
    const document = composeMultipleChoiceDocument(textDoc('Câu hỏi?'), answers);
    // Mô phỏng kéo-thả: choice cuối lên đầu trong tài liệu thống nhất.
    const choiceList = document.content[document.content.length - 1] as {
      content: MultipleChoiceDocumentJson['content'];
    };
    const moved = choiceList.content.splice(3, 1)[0];
    if (moved) choiceList.content.unshift(moved);

    const { choices } = splitMultipleChoiceDocument(document);
    expect(choices.map((choice) => choice.attrs.id)).toEqual(['ans-4', 'ans-1', 'ans-2', 'ans-3']);
  });

  it('renders one correct-answer radio per choice and reports the picked choice id', async () => {
    const answers = [1, 2, 3, 4].map((n) => ({
      id: `ans-${n}`,
      answer: textDoc(`Phương án ${n}`),
      sortOrder: n,
    }));
    const document = composeMultipleChoiceDocument(textDoc('Câu hỏi?'), answers);
    const onCorrectChoiceChange = vi.fn();
    const { container } = render(
      <MultipleChoiceEditor
        value={document}
        onChange={() => {}}
        correctChoiceId="ans-2"
        onCorrectChoiceChange={onCorrectChoiceChange}
        ariaLabel="Soạn câu trắc nghiệm"
      />,
    );

    const radios = await screen.findAllByRole('radio', { name: 'Đặt làm đáp án đúng' });
    expect(radios).toHaveLength(MULTIPLE_CHOICE_COUNT);
    expect((radios[1] as HTMLInputElement).checked).toBe(true);
    expect((radios[0] as HTMLInputElement).checked).toBe(false);
    // Tài liệu ProseMirror chứa đúng 4 node choice trong choiceList.
    expect(container.querySelectorAll('[data-choice]')).toHaveLength(MULTIPLE_CHOICE_COUNT);

    fireEvent.click(radios[3] as HTMLInputElement);
    expect(onCorrectChoiceChange).toHaveBeenCalledWith('ans-4');
  });
});

describe('TrueFalse authoring document (TF-A)', () => {
  const textBlocks = (text: string) => [{ type: 'paragraph', content: [{ type: 'text', text }] }];

  it('creates an empty document with exactly four identified statements', () => {
    const document = createEmptyTrueFalseDocument();
    const { stem, statements } = splitTrueFalseDocument(document);

    expect(stem.content).toHaveLength(1);
    expect(statements).toHaveLength(TRUE_FALSE_STATEMENT_COUNT);
    expect(new Set(statements.map((s) => s.attrs.id)).size).toBe(TRUE_FALSE_STATEMENT_COUNT);
    // Chưa có đáp án Đ/S cho mệnh đề nào -> chưa hoàn chỉnh.
    expect(isCompleteTrueFalse(document, {})).toBe(false);
  });

  it('composes a stored TF document losslessly and completeness follows the per-statement answers', () => {
    const stored: RichTextDocument = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Cho tam giác ABC. Xét các mệnh đề:' }] },
        {
          type: 'statementList',
          content: ['m1', 'm2', 'm3', 'm4'].map((id, i) => ({
            type: 'statement' as const,
            attrs: { id },
            content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: `Mệnh đề ${i + 1}` }] }],
          })),
        },
      ],
    };
    const document = composeTrueFalseDocument(stored);
    // Tài liệu TF lưu trữ THỐNG NHẤT với tài liệu soạn: compose không đổi hình dạng.
    expect(document).toEqual(stored);
    expect(getTrueFalseStatementIds(document)).toEqual(['m1', 'm2', 'm3', 'm4']);
    const { stem, statements } = splitTrueFalseDocument(document);
    expect(stem.content?.[0]?.content?.[0]?.text).toBe('Cho tam giác ABC. Xét các mệnh đề:');
    expect(statements.map((s) => s.attrs.id)).toEqual(['m1', 'm2', 'm3', 'm4']);

    const answers = { m1: true, m2: false, m3: true, m4: false };
    expect(isCompleteTrueFalse(document, answers)).toBe(true);
    // Thiếu đáp án của một mệnh đề -> chưa hoàn chỉnh (mỗi mệnh đề phải có Đ/S).
    expect(isCompleteTrueFalse(document, { m1: true, m2: false, m3: true })).toBe(false);
    // Thân câu rỗng -> chưa hoàn chỉnh dù đáp án đủ.
    const emptyStem = composeTrueFalseDocument({
      type: 'doc',
      content: [
        { type: 'paragraph' },
        {
          type: 'statementList',
          content: ['m1', 'm2', 'm3', 'm4'].map((id) => ({
            type: 'statement' as const,
            attrs: { id },
            content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Ý' }] }],
          })),
        },
      ],
    });
    expect(isCompleteTrueFalse(emptyStem, answers)).toBe(false);
    void textBlocks;
  });

  it('renders the stored TF document statically with its stem and every statement', () => {
    const stored: RichTextDocument = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Thân câu hiển thị' }] },
        {
          type: 'statementList',
          content: ['m1', 'm2'].map((id, i) => ({
            type: 'statement' as const,
            attrs: { id },
            content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: `Nội dung mệnh đề ${i + 1}` }] }],
          })),
        },
      ],
    };
    const { container } = render(<RichTextView value={stored} />);
    expect(container.textContent).toContain('Thân câu hiển thị');
    expect(container.textContent).toContain('Nội dung mệnh đề 1');
    expect(container.textContent).toContain('Nội dung mệnh đề 2');
    expect(container.querySelectorAll('ol.lms-statement-list li')).toHaveLength(2);
  });

  it('renders one Đúng/Sai radio pair per statement and reports the picked value by statement id', async () => {
    const document = composeTrueFalseDocument({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Thân câu' }] },
        {
          type: 'statementList',
          content: ['m1', 'm2', 'm3', 'm4'].map((id) => ({
            type: 'statement' as const,
            attrs: { id },
            content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: `Ý ${id}` }] }],
          })),
        },
      ],
    });
    const onAnswerChange = vi.fn();
    const { container } = render(
      <TrueFalseEditor
        value={document}
        onChange={() => {}}
        answers={{ m2: false }}
        onAnswerChange={onAnswerChange}
        ariaLabel="Soạn câu đúng/sai"
      />,
    );

    const trueRadios = await screen.findAllByRole('radio', { name: 'Đánh dấu mệnh đề là Đúng' });
    const falseRadios = await screen.findAllByRole('radio', { name: 'Đánh dấu mệnh đề là Sai' });
    expect(trueRadios).toHaveLength(TRUE_FALSE_STATEMENT_COUNT);
    expect(falseRadios).toHaveLength(TRUE_FALSE_STATEMENT_COUNT);
    expect((falseRadios[1] as HTMLInputElement).checked).toBe(true);
    expect((trueRadios[1] as HTMLInputElement).checked).toBe(false);
    expect(container.querySelectorAll('[data-statement]')).toHaveLength(TRUE_FALSE_STATEMENT_COUNT);

    fireEvent.click(trueRadios[2] as HTMLInputElement);
    expect(onAnswerChange).toHaveBeenCalledWith('m3', true);
  });
});
