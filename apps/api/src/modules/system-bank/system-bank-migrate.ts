/**
 * CLI di trú dữ kiện Ngân hàng hệ thống từ kho nghiệp vụ chung sang kho
 * ngân hàng riêng (issue #585) — chạy BẰNG TAY sau khi kho ngân hàng đã
 * tồn tại (setup + migration kho ngân hàng), KHÔNG nằm trong chuỗi
 * migrate của compose (như seed):
 * `DATABASE_URL=<kho nghiệp vụ> SYSTEM_BANK_DATABASE_URL=<kho ngân hàng> pnpm system-bank:migrate [--with-outcome-package <phiên bản>]`
 *
 * Nguồn: câu hỏi thuộc bank platform (category.bank_id trỏ bank có
 * scope='platform' và kind='question' — chỉ liên kết bank_id tường
 * minh mới tính là câu hệ thống; category chưa gán bank được app suy
 * về bank trường/cá nhân, không bao giờ suy về platform nên không di
 * trú). Ánh xạ trạng thái entry → trạng thái câu ngân hàng:
 * ready → published; hidden → withdrawn (kèm lý do/người/thời điểm
 * rút từ entry); draft → BỎ QUA và báo cáo (câu đang soạn chưa phát
 * hành không được phơi thành câu hệ thống).
 *
 * Ghi: upsert theo id giữ nguyên (câu + version + liên kết YCCĐ) nên
 * chạy lại an toàn; gói phiên bản đóng theo đúng hợp đồng gói bất
 * biến (nội dung + đáp án + quy tắc chấm + phản hồi + ngữ liệu +
 * liên kết YCCĐ của câu, không phải của version — liên kết gắn ở cấp
 * câu nên mọi version của cùng câu mang cùng tập liên kết tại thời
 * điểm di trú). Checksum tính lại bằng cùng hàm canonical với service
 * (lệch là di trú vỡ, thoát lỗi ngay).
 *
 * Đối soát: in số lượng trước/sau (câu, version, ngữ liệu phân biệt,
 * liên kết chuẩn) + số câu draft bỏ qua. Hàng platform trong kho chung
 * GIỮ NGUYÊN sau di trú (không xoá): slot đề cũ còn trỏ id câu trong
 * kho chung; việc cụ thể hoá bản chụp cho đề cũ thuộc issue #587.
 * Từ sau PR này, ghi mới cho câu hệ thống chỉ qua admin API của kho
 * ngân hàng; bank platform trong kho chung thành dữ kiện cũ chỉ đọc.
 *
 * Cờ `--with-outcome-package <phiên bản>`: phát hành thêm gói YCCĐ
 * đầu tiên từ cây chương trình hiện hành (chỉ YCCĐ chuẩn platform
 * đang hiện hành: tenantId NULL, retiredAt NULL) — cùng bộ lọc với
 * đường phát hành gói của service; đây là công cụ di trú một lần nên
 * phần chụp cây viết trực tiếp trong script (service là đường chạy
 * thường xuyên, không phải đường di trú).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Pool } from 'pg';
import {
  curricula,
  curriculumNodes,
  learningOutcomes,
  question,
  questionAnswerKeys,
  questionAnswers,
  questionBankEntries,
  questionBanks,
  questionCategories,
  questionLearningOutcomes,
  qtypeEssayOptions,
  qtypeMultichoiceOptions,
  qtypeShortanswerOptions,
  questionVersions,
  stimuli,
  subjects,
} from '@lms/db';
import {
  systemOutcomePackageCurricula,
  systemOutcomePackageNodes,
  systemOutcomePackageOutcomes,
  systemOutcomePackages,
  systemQuestionVersionOutcomes,
  systemQuestionVersions,
  systemQuestions,
} from '@lms/db/system-bank';
import { canonicalizeJson, checksumPackage, packageValidationError, type SystemQuestionPackage } from './system-bank-package';

async function main(): Promise<void> {
  const businessUrl = process.env.DATABASE_URL;
  const bankUrl = process.env.SYSTEM_BANK_DATABASE_URL;
  if (!businessUrl) throw new Error('DATABASE_URL is required');
  if (!bankUrl) throw new Error('SYSTEM_BANK_DATABASE_URL is required');
  const args = process.argv.slice(2);
  const packageFlagIndex = args.indexOf('--with-outcome-package');
  const packageVersion = packageFlagIndex >= 0 ? args[packageFlagIndex + 1] : undefined;
  if (packageFlagIndex >= 0 && !packageVersion) throw new Error('--with-outcome-package requires a version');

  const businessPool = new Pool({ connectionString: businessUrl });
  const bankPool = new Pool({ connectionString: bankUrl });
  const business = drizzle({ client: businessPool });
  const bank = drizzle({ client: bankPool });
  try {
    const platformBanks = await business
      .select({ id: questionBanks.id })
      .from(questionBanks)
      .where(and(eq(questionBanks.scope, 'platform'), eq(questionBanks.bankKind, 'question')));
    const platformBankIds = platformBanks.map((row) => row.id);
    const categories =
      platformBankIds.length === 0
        ? []
        : await business
            .select({ id: questionCategories.id })
            .from(questionCategories)
            .where(inArray(questionCategories.bankId, platformBankIds));
    const categoryIds = categories.map((row) => row.id);
    const questions =
      categoryIds.length === 0
        ? []
        : await business.select().from(question).where(inArray(question.category, categoryIds));
    const questionIds = questions.map((row) => row.id);
    const entries =
      questionIds.length === 0
        ? []
        : await business
            .select()
            .from(questionBankEntries)
            .where(inArray(questionBankEntries.questionId, questionIds));
    const entryByQuestion = new Map(entries.map((row) => [row.questionId, row]));
    const versions =
      questionIds.length === 0
        ? []
        : await business.select().from(questionVersions).where(inArray(questionVersions.questionId, questionIds));
    const versionIds = versions.map((row) => row.id);
    const answers =
      versionIds.length === 0
        ? []
        : await business.select().from(questionAnswers).where(inArray(questionAnswers.questionVersionId, versionIds));
    const answerKeys =
      versionIds.length === 0
        ? []
        : await business.select().from(questionAnswerKeys).where(inArray(questionAnswerKeys.questionVersionId, versionIds));
    const multichoiceOptions =
      versionIds.length === 0
        ? []
        : await business
            .select()
            .from(qtypeMultichoiceOptions)
            .where(inArray(qtypeMultichoiceOptions.questionVersionId, versionIds));
    const shortanswerOptions =
      versionIds.length === 0
        ? []
        : await business
            .select()
            .from(qtypeShortanswerOptions)
            .where(inArray(qtypeShortanswerOptions.questionVersionId, versionIds));
    const essayOptions =
      versionIds.length === 0
        ? []
        : await business.select().from(qtypeEssayOptions).where(inArray(qtypeEssayOptions.questionVersionId, versionIds));
    const stimulusIds = [...new Set(versions.map((row) => row.stimulusId).filter((id): id is string => id !== null))];
    const stimulusRows =
      stimulusIds.length === 0
        ? []
        : await business.select().from(stimuli).where(inArray(stimuli.id, stimulusIds));
    const stimulusById = new Map(stimulusRows.map((row) => [row.id, row.content]));
    const links =
      questionIds.length === 0
        ? []
        : await business
            .select()
            .from(questionLearningOutcomes)
            .where(inArray(questionLearningOutcomes.questionId, questionIds));

    const answersByVersion = new Map<string, typeof answers>();
    for (const row of answers) {
      const list = answersByVersion.get(row.questionVersionId) ?? [];
      list.push(row);
      answersByVersion.set(row.questionVersionId, list);
    }
    const answerKeyByVersion = new Map(answerKeys.map((row) => [row.questionVersionId, row]));
    const multichoiceByVersion = new Map(multichoiceOptions.map((row) => [row.questionVersionId, row]));
    const shortanswerByVersion = new Map(shortanswerOptions.map((row) => [row.questionVersionId, row]));
    const essayByVersion = new Map(essayOptions.map((row) => [row.questionVersionId, row]));
    const linksByQuestion = new Map<string, typeof links>();
    for (const row of links) {
      const list = linksByQuestion.get(row.questionId) ?? [];
      list.push(row);
      linksByQuestion.set(row.questionId, list);
    }

    let migratedQuestions = 0;
    let migratedVersions = 0;
    let skippedDrafts = 0;
    let skippedQtypes = 0;
    for (const q of questions) {
      const entry = entryByQuestion.get(q.id);
      const status = entry?.status ?? 'ready';
      if (status === 'draft') {
        skippedDrafts += 1;
        continue;
      }
      if (!['multichoice', 'truefalse', 'shortanswer', 'essay'].includes(q.qtype)) {
        skippedQtypes += 1;
        continue;
      }
      const bankStatus = status === 'hidden' ? 'withdrawn' : 'published';
      await bank
        .insert(systemQuestions)
        .values({
          id: q.id,
          qtype: q.qtype,
          status: bankStatus,
          withdrawnReason: entry?.withdrawnReason ?? null,
          withdrawnBy: entry?.withdrawnBy ?? null,
          withdrawnAt: entry?.withdrawnAt ?? null,
        })
        .onConflictDoUpdate({
          target: systemQuestions.id,
          set: {
            qtype: q.qtype,
            status: bankStatus,
            withdrawnReason: entry?.withdrawnReason ?? null,
            withdrawnBy: entry?.withdrawnBy ?? null,
            withdrawnAt: entry?.withdrawnAt ?? null,
          },
        });
      migratedQuestions += 1;
      const questionVersions = versions.filter((row) => row.questionId === q.id);
      const questionLinks = (linksByQuestion.get(q.id) ?? []).map((row) => ({
        outcomeId: row.learningOutcomeId,
        cognitiveLevel: row.cognitiveLevel,
      }));
      for (const version of questionVersions) {
        const versionAnswers = [...(answersByVersion.get(version.id) ?? [])].sort(
          (a, b) => a.sortOrder - b.sortOrder,
        );
        const answerKey = answerKeyByVersion.get(version.id);
        const options =
          q.qtype === 'multichoice'
            ? (() => {
                const row = multichoiceByVersion.get(version.id);
                return row
                  ? {
                      shuffleAnswers: row.shuffleAnswers,
                      answerNumbering: row.answerNumbering,
                      correctFeedback: row.correctFeedback,
                      incorrectFeedback: row.incorrectFeedback,
                      showStandardInstruction: row.showStandardInstruction,
                    }
                  : null;
              })()
            : q.qtype === 'shortanswer'
              ? (() => {
                  const row = shortanswerByVersion.get(version.id);
                  return row
                    ? {
                        useCase: row.useCase,
                        numericAnswer: row.numericAnswer,
                        numericMaxLength: row.numericMaxLength,
                        numericAllowSign: row.numericAllowSign,
                        numericAllowDecimal: row.numericAllowDecimal,
                      }
                    : null;
                })()
              : q.qtype === 'essay'
                ? (() => {
                    const row = essayByVersion.get(version.id);
                    return row
                      ? {
                          responseFormat: row.responseFormat,
                          responseRequired: row.responseRequired,
                          responseFieldLines: row.responseFieldLines,
                          minWordLimit: row.minWordLimit,
                          maxWordLimit: row.maxWordLimit,
                          graderInfo: row.graderInfo,
                          responseTemplate: row.responseTemplate,
                        }
                      : null;
                  })()
                : null;
        const pkg: SystemQuestionPackage = {
          questionText: version.questionText,
          generalFeedback: version.generalFeedback,
          stimulusContent: version.stimulusId ? (stimulusById.get(version.stimulusId) ?? null) : null,
          answers: versionAnswers.map((row) => ({
            answer: row.answer,
            isCorrect: row.isCorrect,
            feedback: row.feedback,
            sortOrder: row.sortOrder,
          })),
          answerKey: answerKey ? { guidance: answerKey.guidance, solution: answerKey.solution } : null,
          options,
          outcomes: questionLinks,
        };
        const validation = packageValidationError(q.qtype, pkg);
        if (validation) {
          throw new Error(`system-bank-migrate: question ${q.id} version ${version.version} failed package validation: ${validation}`);
        }
        const checksum = checksumPackage(pkg);
        await bank
          .insert(systemQuestionVersions)
          .values({
            id: version.id,
            questionId: q.id,
            version: version.version,
            checksum,
            package: pkg as never,
          })
          .onConflictDoUpdate({
            target: systemQuestionVersions.id,
            set: { questionId: q.id, version: version.version, checksum, package: pkg as never },
          });
        await bank
          .delete(systemQuestionVersionOutcomes)
          .where(eq(systemQuestionVersionOutcomes.versionId, version.id));
        if (questionLinks.length > 0) {
          await bank.insert(systemQuestionVersionOutcomes).values(
            questionLinks.map((link) => ({
              versionId: version.id,
              outcomeId: link.outcomeId,
              cognitiveLevel: link.cognitiveLevel,
            })),
          );
        }
        migratedVersions += 1;
      }
    }

    let packageInfo: { version: string; outcomes: number } | null = null;
    if (packageVersion) {
      const subjectRows = await business.select().from(subjects);
      const subjectIds = subjectRows.map((row) => row.id);
      const curriculumRows =
        subjectIds.length === 0
          ? []
          : await business.select().from(curricula).where(inArray(curricula.subjectId, subjectIds));
      const curriculumIds = curriculumRows.map((row) => row.id);
      const nodeRows =
        curriculumIds.length === 0
          ? []
          : await business.select().from(curriculumNodes).where(inArray(curriculumNodes.curriculumId, curriculumIds));
      const nodeIds = nodeRows.map((row) => row.id);
      const outcomeRows =
        nodeIds.length === 0
          ? []
          : await business
              .select()
              .from(learningOutcomes)
              .where(
                and(
                  inArray(learningOutcomes.nodeId, nodeIds),
                  isNull(learningOutcomes.tenantId),
                  isNull(learningOutcomes.retiredAt),
                ),
              );
      const subjectSlugById = new Map(subjectRows.map((row) => [row.id, row.slug]));
      const packageCurricula = curriculumRows.map((row) => ({
        curriculumId: row.id,
        subjectSlug: subjectSlugById.get(row.subjectId) ?? '',
        grade: row.grade,
      }));
      const packageNodes = nodeRows.map((row) => ({
        nodeId: row.id,
        curriculumId: row.curriculumId,
        parentId: row.parentId,
        title: row.title,
        kind: row.kind,
        position: row.position,
        durationPeriods: row.durationPeriods,
        durationPercent: row.durationPercent,
      }));
      const packageOutcomes = outcomeRows.map((row) => ({
        outcomeId: row.id,
        nodeId: row.nodeId,
        position: row.position,
        content: row.content,
        sourceKind: row.sourceKind,
        sourceRef: row.sourceRef,
      }));
      const checksum = await import('node:crypto').then((crypto) =>
        crypto
          .createHash('sha256')
          .update(
            canonicalizeJson({
              curricula: packageCurricula,
              nodes: packageNodes,
              outcomes: packageOutcomes,
              mappings: [],
            }),
          )
          .digest('hex'),
      );
      const [pkgRow] = await bank
        .insert(systemOutcomePackages)
        .values({
          version: packageVersion,
          scope: 'all',
          checksum,
          outcomeCount: packageOutcomes.length,
          createdBy: null,
        })
        .onConflictDoNothing({ target: systemOutcomePackages.version })
        .returning();
      if (pkgRow) {
        if (packageCurricula.length > 0) {
          await bank.insert(systemOutcomePackageCurricula).values(
            packageCurricula.map((row) => ({ packageId: pkgRow.id, ...row })),
          );
        }
        if (packageNodes.length > 0) {
          await bank.insert(systemOutcomePackageNodes).values(
            packageNodes.map((row) => ({ packageId: pkgRow.id, ...row })),
          );
        }
        if (packageOutcomes.length > 0) {
          await bank.insert(systemOutcomePackageOutcomes).values(
            packageOutcomes.map((row) => ({ packageId: pkgRow.id, ...row, content: row.content as never })),
          );
        }
        packageInfo = { version: packageVersion, outcomes: packageOutcomes.length };
      } else {
        console.log(`  outcome package: version=${packageVersion} already exists, skipped`);
      }
    }

    const afterQuestions = await bank.select({ id: systemQuestions.id }).from(systemQuestions);
    const afterVersions = await bank.select({ id: systemQuestionVersions.id }).from(systemQuestionVersions);
    const afterLinks = await bank.select({ id: systemQuestionVersionOutcomes.id }).from(systemQuestionVersionOutcomes);
    console.log('system-bank-migrate: done');
    console.log(`  before: questions=${questions.length} versions=${versions.length} distinct_stimuli=${stimulusIds.length} standards_links=${links.length}`);
    console.log(`  migrated: questions=${migratedQuestions} versions=${migratedVersions} skipped_drafts=${skippedDrafts} skipped_qtypes=${skippedQtypes}`);
    console.log(`  after: questions=${afterQuestions.length} versions=${afterVersions.length} version_outcome_links=${afterLinks.length}`);
    if (packageInfo) console.log(`  outcome package: version=${packageInfo.version} outcomes=${packageInfo.outcomes}`);
  } finally {
    await businessPool.end();
    await bankPool.end();
  }
}

main().catch((err: unknown) => {
  console.error('system-bank-migrate: failed', err instanceof Error ? err.message : err);
  process.exit(1);
});
