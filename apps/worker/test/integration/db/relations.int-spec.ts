/**
 * Spec tương đương cho relations của miền câu hỏi (issue #494).
 *
 * Mục đích: chứng minh tầng relational query (`db.query.*`) chạy được trên
 * relations khai trong `src/db/relations.ts` và cho kết quả TRÙNG KHỚP với
 * truy vấn join tay tương đương trên cùng một dữ kiện — tức việc khai
 * relations không làm lệch dữ liệu ở bất kỳ chiều quan hệ nào của miền câu
 * hỏi (câu → danh mục, câu → mục ngân hàng, câu → version → đáp án và
 * chiều ngược từ version về câu/mục ngân hàng).
 *
 * Cách dựng: spec KHÔNG boot WorkerModule — nó tạo client Drizzle đúng
 * cách worker tạo (`drizzle({ client: pool, relations })` với pool `pg`
 * thường) vì đối tượng kiểm chứng của issue là chính metadata relations.
 * Dữ kiện là một cây câu hỏi tối thiểu gắn vào tenant riêng của spec, id
 * cố định, dọn trước khi nạp và sau khi chạy xong để không va chạm với
 * spec khác dùng chung cơ sở dữ liệu test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import {
  question,
  questionAnswers,
  questionBankEntries,
  questionBanks,
  questionCategories,
  questionVersions,
  tenants,
} from '@lms/db';
import { relations } from '../../../src/db/relations';

/** Id cố định của cây dữ kiện kiểm chứng — tiền tố riêng của spec này. */
const IDS = {
  tenant: '01949400-0000-7000-8000-000000000001',
  bank: '01949400-0000-7000-8000-000000000002',
  category: '01949400-0000-7000-8000-000000000003',
  question: '01949400-0000-7000-8000-000000000004',
  entry: '01949400-0000-7000-8000-000000000005',
  version: '01949400-0000-7000-8000-000000000006',
  answerCorrect: '01949400-0000-7000-8000-000000000007',
  answerWrong: '01949400-0000-7000-8000-000000000008',
  context: '01949400-0000-7000-8000-0000000000f0',
  author: '01949400-0000-7000-8000-0000000000f1',
} as const;

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/lms_test_worker',
});
const db = drizzle({ client: pool, relations });

/** Sắp xếp bản sao mảng theo id để phép so sánh không phụ thuộc thứ tự trả về của từng đường truy vấn. */
function sortById<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id));
}

/** Xoá cây dữ kiện theo thứ tự con trước cha — idempotent để chạy lại sau một lượt dở dang vẫn sạch. */
async function deleteFixture(): Promise<void> {
  await db
    .delete(questionAnswers)
    .where(inArray(questionAnswers.id, [IDS.answerCorrect, IDS.answerWrong]));
  await db.delete(questionVersions).where(eq(questionVersions.id, IDS.version));
  await db.delete(questionBankEntries).where(eq(questionBankEntries.id, IDS.entry));
  await db.delete(question).where(eq(question.id, IDS.question));
  await db.delete(questionCategories).where(eq(questionCategories.id, IDS.category));
  await db.delete(questionBanks).where(eq(questionBanks.id, IDS.bank));
  await db.delete(tenants).where(eq(tenants.id, IDS.tenant));
}

/** Nạp cây câu hỏi tối thiểu: tenant → ngân hàng → danh mục → câu → mục ngân hàng → version → 2 đáp án. */
async function insertFixture(): Promise<void> {
  await db.insert(tenants).values({
    id: IDS.tenant,
    slug: 'relations-equiv-494',
    name: 'Tenant kiểm chứng relations',
    kind: 'center',
  });
  await db.insert(questionBanks).values({
    id: IDS.bank,
    tenantId: IDS.tenant,
    name: 'Ngân hàng kiểm chứng relations',
    scope: 'school',
    contextId: IDS.context,
    createdBy: IDS.author,
  });
  await db.insert(questionCategories).values({
    id: IDS.category,
    name: 'Danh mục kiểm chứng relations',
    contextId: IDS.context,
    bankId: IDS.bank,
  });
  await db.insert(question).values({
    id: IDS.question,
    category: IDS.category,
    qtype: 'multichoice',
  });
  await db.insert(questionBankEntries).values({
    id: IDS.entry,
    questionCategoryId: IDS.category,
    questionId: IDS.question,
  });
  await db.insert(questionVersions).values({
    id: IDS.version,
    questionBankEntryId: IDS.entry,
    questionId: IDS.question,
    version: 1,
    questionText: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Câu hỏi kiểm chứng relations?' }],
        },
      ],
    },
  });
  await db.insert(questionAnswers).values([
    {
      id: IDS.answerCorrect,
      questionVersionId: IDS.version,
      answer: { type: 'doc', content: [{ type: 'paragraph' }] },
      isCorrect: true,
      sortOrder: 0,
    },
    {
      id: IDS.answerWrong,
      questionVersionId: IDS.version,
      answer: { type: 'doc', content: [{ type: 'paragraph' }] },
      isCorrect: false,
      sortOrder: 1,
    },
  ]);
}

describe('Relations miền câu hỏi — db.query trùng khớp join tay', () => {
  beforeAll(async () => {
    await deleteFixture();
    await insertFixture();
  });

  afterAll(async () => {
    await deleteFixture();
    await pool.end();
  });

  it('nạp cây câu hỏi từ gốc câu hỏi qua db.query cho kết quả trùng khớp truy vấn join tay tương đương', async () => {
    const viaRelations = await db.query.question.findFirst({
      where: { id: IDS.question },
      with: {
        categoryRef: true,
        questionBankEntries: true,
        questionVersions: { with: { questionAnswers: true } },
      },
    });
    expect(viaRelations).toBeDefined();
    if (!viaRelations) return;

    // Đường join tay tương đương: select từng bảng theo khoá ngoại thật rồi ghép lồng nhau.
    const [questionRow] = await db
      .select()
      .from(question)
      .where(eq(question.id, IDS.question));
    const [categoryRow] = await db
      .select()
      .from(questionCategories)
      .where(eq(questionCategories.id, IDS.category));
    const entryRows = await db
      .select()
      .from(questionBankEntries)
      .where(eq(questionBankEntries.questionId, IDS.question));
    const versionRows = await db
      .select()
      .from(questionVersions)
      .where(eq(questionVersions.questionId, IDS.question));
    const versionsWithAnswers = [];
    for (const versionRow of versionRows) {
      const answerRows = await db
        .select()
        .from(questionAnswers)
        .where(eq(questionAnswers.questionVersionId, versionRow.id));
      versionsWithAnswers.push({ ...versionRow, questionAnswers: sortById(answerRows) });
    }

    expect({
      ...viaRelations,
      questionBankEntries: sortById(viaRelations.questionBankEntries),
      questionVersions: sortById(
        viaRelations.questionVersions.map((version) => ({
          ...version,
          questionAnswers: sortById(version.questionAnswers),
        })),
      ),
    }).toEqual({
      ...questionRow,
      categoryRef: categoryRow,
      questionBankEntries: sortById(entryRows),
      questionVersions: sortById(versionsWithAnswers),
    });
  });

  it('nạp một version kèm câu hỏi, mục ngân hàng và đáp án qua db.query cho kết quả trùng khớp truy vấn join tay tương đương', async () => {
    const viaRelations = await db.query.questionVersions.findFirst({
      where: { id: IDS.version },
      with: { question: true, questionBankEntry: true, questionAnswers: true },
    });
    expect(viaRelations).toBeDefined();
    if (!viaRelations) return;

    // Đường join tay tương đương từ gốc version.
    const [versionRow] = await db
      .select()
      .from(questionVersions)
      .where(eq(questionVersions.id, IDS.version));
    const [questionRow] = await db
      .select()
      .from(question)
      .where(eq(question.id, IDS.question));
    const [entryRow] = await db
      .select()
      .from(questionBankEntries)
      .where(eq(questionBankEntries.id, IDS.entry));
    const answerRows = await db
      .select()
      .from(questionAnswers)
      .where(eq(questionAnswers.questionVersionId, IDS.version));

    expect({ ...viaRelations, questionAnswers: sortById(viaRelations.questionAnswers) }).toEqual({
      ...versionRow,
      question: questionRow,
      questionBankEntry: entryRow,
      questionAnswers: sortById(answerRows),
    });
  });
});
