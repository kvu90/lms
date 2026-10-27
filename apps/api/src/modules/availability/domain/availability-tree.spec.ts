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

describe('AvailabilityTree golden (tree_test.php::test_check_available)', () => {
  it('no conditions is available', async () => {
    expect((await ev({ op: '|', c: [] }, {})).available).toBe(true);
    expect((await ev({ op: '&', c: [] }, {})).available).toBe(true);
  });

  it('single condition yes/no', async () => {
    expect((await ev({ op: '&', c: [{ type: 'mock', id: 'a' }] }, { a: true })).available).toBe(true);
    const no = await ev({ op: '&', c: [{ type: 'mock', id: 'a' }] }, { a: false });
    expect(no.available).toBe(false);
    expect(no.failedDescriptions).toEqual(['A']);
  });

  it('OR: one true is available; both false is not, with both descriptions', async () => {
    expect((await ev({ op: '|', c: [{ type: 'mock', id: 'a' }, { type: 'mock', id: 'b' }] }, { a: false, b: true })).available).toBe(true);
    const both = await ev({ op: '|', c: [{ type: 'mock', id: 'a' }, { type: 'mock', id: 'b' }] }, { a: false, b: false });
    expect(both.available).toBe(false);
    expect(both.failedDescriptions).toEqual(['A', 'B']);
  });

  it('OR both false with root show=false hides all information (item hidden)', async () => {
    const r = await ev({ op: '|', show: false, c: [{ type: 'mock', id: 'a' }, { type: 'mock', id: 'b' }] }, { a: false, b: false });
    expect(r.available).toBe(false);
    expect(r.informationHidden).toBe(true);
    expect(r.visible).toBe(false);
    expect(r.failedDescriptions).toEqual([]);
  });

  it('AND: both true available; one false fails with that description only', async () => {
    const tree: AvailabilityNode = { op: '&', showc: [true, true], c: [{ type: 'mock', id: 'a' }, { type: 'mock', id: 'b' }] };
    expect((await ev(tree, { a: true, b: true })).available).toBe(true);
    const one = await ev(tree, { a: false, b: true });
    expect(one.available).toBe(false);
    expect(one.failedDescriptions).toEqual(['A']);
    const bothFail = await ev(tree, { a: false, b: false });
    expect(bothFail.failedDescriptions).toEqual(['A', 'B']);
  });

  it('AND with showc[0]=false: a failure of that child hides all information', async () => {
    const tree: AvailabilityNode = { op: '&', showc: [false, true], c: [{ type: 'mock', id: 'a' }, { type: 'mock', id: 'b' }] };
    const r = await ev(tree, { a: false, b: false });
    expect(r.available).toBe(false);
    expect(r.informationHidden).toBe(true);
    expect(r.visible).toBe(false);
  });

  it('NOT-OR (!|): both false is available; any true fails (De Morgan: !| = NOT(a OR b))', async () => {
    const tree: AvailabilityNode = { op: '!|', showc: [true, true], c: [{ type: 'mock', id: 'a' }, { type: 'mock', id: 'b' }] };
    expect((await ev(tree, { a: false, b: false })).available).toBe(true);
    expect((await ev(tree, { a: true, b: false })).available).toBe(false);
    expect((await ev(tree, { a: true, b: true })).available).toBe(false);
  });

  it('NOT-AND (!&): both true fails; one false is available (De Morgan: !& = NOT(a AND b))', async () => {
    const tree: AvailabilityNode = { op: '!&', show: true, c: [{ type: 'mock', id: 'a' }, { type: 'mock', id: 'b' }] };
    expect((await ev(tree, { a: true, b: true })).available).toBe(false);
    expect((await ev(tree, { a: true, b: false })).available).toBe(true);
    expect((await ev(tree, { a: false, b: false })).available).toBe(true);
  });

  it('nested: NOT-AND root containing a nested NOT-AND (Moodle nested NOT case)', async () => {
    // tree_test: op ngoài là !& (mang sang từ ca trước), nút con là một
    // cây !& lồng nhau với một điều kiện đúng: trong = !(true) = false,
    // ngoài = !(false) = true. Khi lá là false: trong=true, ngoài=false.
    const tree: AvailabilityNode = { op: '!&', show: true, c: [{ op: '!&', c: [{ type: 'mock', id: 'a' }] }] };
    expect((await ev(tree, { a: true })).available).toBe(true);
    expect((await ev(tree, { a: false })).available).toBe(false);
  });

  it('nested AND inside OR with a failing leaf (Moodle nested groups message case structure)', async () => {
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

  it('GOLDEN required case: AND nested inside !| with showc matches the truth table', async () => {
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

  it('parse rejects malformed trees (PHP-detail construct errors become 400-level validation)', () => {
    expect(() => parseAvailabilityTree({ op: 'xor', c: [] })).toThrow();
    expect(() => parseAvailabilityTree({ op: '&' })).toThrow();
    expect(parseAvailabilityTree(null)).toBeNull();
    expect(parseAvailabilityTree({ op: '&', c: [{ type: 'date', d: '>=', t: 0 }] })?.op).toBe('&');
  });
});
