import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { richTextDocumentSchema, type RichTextDocument } from '@lms/contracts';
import { RichTextEditor } from './RichTextEditor.js';
import { RichTextView } from './RichTextView.js';

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
    render(<RichTextEditor onChange={onChange} />);

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
    render(<RichTextEditor onChange={onChange} />);

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
    render(<RichTextEditor onChange={onChange} />);

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
    render(<RichTextEditor value={initial} onChange={onChange} />);

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
    render(<RichTextEditor onChange={onChange} onRequestImage={onRequestImage} />);

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

  it('hides the image button when the host provides no image callback', () => {
    render(<RichTextEditor />);

    expect(screen.queryByRole('button', { name: 'Chèn ảnh' })).toBeNull();
  });
});
