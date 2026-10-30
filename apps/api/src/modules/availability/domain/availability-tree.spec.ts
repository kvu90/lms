import { describe, expect, it } from 'vitest';
import { evaluateTree, leafFromMap, parseAvailabilityTree, type AvailabilityNode } from './availability-tree';

/**
 * Các test availability dạng GOLDEN.
 * Oracle: Moodle availability/tests/tree_test.php ::test_check_available
 * (MOODLE_503_STABLE, public/availability/tests/tree_test.php) — các điều kiện mock
 * ở đó (a=true/false, m=message) trở thành các lá được khoá theo `id`
 * tại đây; các assertion về availability + khả năng hiển thị thông tin đi theo
 * đúng thứ tự kịch bản gốc.
 */
const ev = (tree: AvailabilityNode, values: Record<string, boolean>) =>
  evaluateTree(tree, leafFromMap(values, { a: 'A', b: 'B', c1: 'C1' }));

describe('AvailabilityTree chuẩn (tree_test.php::test_check_available)', () => {
  it('không có điều kiện thì khả dụng', async () => {
    expect((await ev({ op: '|', c: [] }, {})).available).toBe(true);
    expect((await ev({ op: '&', c: [] }, {})).available).toBe(true);
  });

  it('một điều kiện: đúng thì khả dụng, sai thì không kèm mô tả lỗi', async () => {
    expect((await ev({ op: '&', c: [{ type: 'mock', id: 'a' }] }, { a: true })).available).toBe(true);
    const no = await ev({ op: '&', c: [{ type: 'mock', id: 'a' }] }, { a: false });
    expect(no.available).toBe(false);
    expect(no.failedDescriptions).toEqual(['A']);
  });

  it('OR: một đúng thì khả dụng; cả hai sai thì không, kèm cả hai mô tả', async () => {
    expect((await ev({ op: '|', c: [{ type: 'mock', id: 'a' }, { type: 'mock', id: 'b' }] }, { a: false, b: true })).available).toBe(true);
    const both = await ev({ op: '|', c: [{ type: 'mock', id: 'a' }, { type: 'mock', id: 'b' }] }, { a: false, b: false });
    expect(both.available).toBe(false);
    expect(both.failedDescriptions).toEqual(['A', 'B']);
  });

  it('OR cả hai sai với show=false ở gốc sẽ giấu mọi thông tin (mục bị ẩn)', async () => {
    const r = await ev({ op: '|', show: false, c: [{ type: 'mock', id: 'a' }, { type: 'mock', id: 'b' }] }, { a: false, b: false });
    expect(r.available).toBe(false);
    expect(r.informationHidden).toBe(true);
    expect(r.visible).toBe(false);
    expect(r.failedDescriptions).toEqual([]);
  });

  it('AND: cả hai đúng thì khả dụng; một sai thì lỗi chỉ với mô tả đó', async () => {
    const tree: AvailabilityNode = { op: '&', showc: [true, true], c: [{ type: 'mock', id: 'a' }, { type: 'mock', id: 'b' }] };
    expect((await ev(tree, { a: true, b: true })).available).toBe(true);
    const one = await ev(tree, { a: false, b: true });
    expect(one.available).toBe(false);
    expect(one.failedDescriptions).toEqual(['A']);
    const bothFail = await ev(tree, { a: false, b: false });
    expect(bothFail.failedDescriptions).toEqual(['A', 'B']);
  });

  it('AND với showc[0]=false: lỗi của con đó giấu mọi thông tin', async () => {
    const tree: AvailabilityNode = { op: '&', showc: [false, true], c: [{ type: 'mock', id: 'a' }, { type: 'mock', id: 'b' }] };
    const r = await ev(tree, { a: false, b: false });
    expect(r.available).toBe(false);
    expect(r.informationHidden).toBe(true);
    expect(r.visible).toBe(false);
  });

  it('NOT-OR (!|): cả hai sai thì khả dụng; bất kỳ đúng nào cũng lỗi (De Morgan: !| = NOT(a OR b))', async () => {
    const tree: AvailabilityNode = { op: '!|', showc: [true, true], c: [{ type: 'mock', id: 'a' }, { type: 'mock', id: 'b' }] };
    expect((await ev(tree, { a: false, b: false })).available).toBe(true);
    expect((await ev(tree, { a: true, b: false })).available).toBe(false);
    expect((await ev(tree, { a: true, b: true })).available).toBe(false);
  });

  it('NOT-AND (!&): cả hai đúng thì lỗi; một sai thì khả dụng (De Morgan: !& = NOT(a AND b))', async () => {
    const tree: AvailabilityNode = { op: '!&', show: true, c: [{ type: 'mock', id: 'a' }, { type: 'mock', id: 'b' }] };
    expect((await ev(tree, { a: true, b: true })).available).toBe(false);
    expect((await ev(tree, { a: true, b: false })).available).toBe(true);
    expect((await ev(tree, { a: false, b: false })).available).toBe(true);
  });

  it('lồng nhau: gốc NOT-AND chứa một NOT-AND lồng (ca NOT lồng của Moodle)', async () => {
    // tree_test: op ngoài là !& (mang sang từ ca trước), nút con là một
    // cây !& lồng nhau với một điều kiện đúng: trong = !(true) = false,
    // ngoài = !(false) = true. Khi lá là false: trong=true, ngoài=false.
    const tree: AvailabilityNode = { op: '!&', show: true, c: [{ op: '!&', c: [{ type: 'mock', id: 'a' }] }] };
    expect((await ev(tree, { a: true })).available).toBe(true);
    expect((await ev(tree, { a: false })).available).toBe(false);
  });

  it('AND lồng trong OR với một lá lỗi (cấu trúc ca thông báo nhóm lồng của Moodle)', async () => {
    const tree: AvailabilityNode = {
      op: '|',
      c: [
        { op: '&', c: [{ type: 'mock', id: 'a' }, { type: 'mock', id: 'b' }] },
        { type: 'mock', id: 'c1' },
      ],
    };
    const r = await ev(tree, { a: false, b: false, c1: false });
    expect(r.available).toBe(false);
    expect(r.failedDescriptions).toEqual(expect.arrayContaining(['A', 'B', 'C1']));
    expect((await ev(tree, { a: true, b: true, c1: false })).available).toBe(true);
  });

  it('ca bắt buộc GOLDEN: AND lồng trong !| với showc khớp bảng chân lý', async () => {
    // !| ( completion AND group )  — chỉ khả dụng khi NOT(cả hai complete&grouped)
    const tree: AvailabilityNode = {
      op: '!|', show: true, showc: [true],
      c: [{ op: '&', showc: [true, true], c: [{ type: 'completion', id: 'comp' }, { type: 'group', id: 'grp' }] }],
    };
    const cases: [boolean, boolean, boolean][] = [
      // comp, grp, khả dụng kỳ vọng
      [false, false, true],
      [true, false, true],
      [false, true, true],
      [true, true, false],
    ];
    for (const [comp, grp, expected] of cases) {
      const r = await evaluateTree(tree, leafFromMap({ comp, grp }));
      expect(r.available, `comp=${comp} grp=${grp}`).toBe(expected);
      // show=true ở gốc: ngay cả khi không khả dụng, mục vẫn hiển thị kèm thông tin.
      expect(r.visible).toBe(true);
    }
    // Cùng cây với show=false: không khả dụng ⇒ bị ẩn hoàn toàn, nhưng vẫn không khả dụng (truy cập bị chặn trong cả hai trường hợp).
    const hidden = await evaluateTree({ ...tree, show: false }, leafFromMap({ comp: true, grp: true }));
    expect(hidden.available).toBe(false);
    expect(hidden.visible).toBe(false);
  });

  it('parse từ chối cây sai định dạng (lỗi dựng chi tiết PHP thành validation mức 400)', () => {
    expect(() => parseAvailabilityTree({ op: 'xor', c: [] })).toThrow();
    expect(() => parseAvailabilityTree({ op: '&' })).toThrow();
    expect(parseAvailabilityTree(null)).toBeNull();
    expect(parseAvailabilityTree({ op: '&', c: [{ type: 'date', d: '>=', t: 0 }] })?.op).toBe('&');
  });
});
