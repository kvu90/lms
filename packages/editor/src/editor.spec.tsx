import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RichTextDocument } from '@lms/contracts';
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
});
