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
 *
 * Mọi truy cập dữ kiện qua handle Kysely của `@lms/db` (kho nghiệp
 * vụ) và `@lms/db/system-bank` (kho ngân hàng); các câu đọc đặt bí
 * danh camelCase cho cột để phần thân dưới giữ nguyên hình dạng dữ
 * kiện như trước (đặc biệt là các mảng trung gian đưa vào checksum
 * của gói YCCĐ — đổi hình dạng là đổi checksum).
 */
import { Pool } from 'pg';
import { createCentreKysely, sql, type JsonValue } from '@lms/db';
import { createSystemBankKysely } from '@lms/db/system-bank';
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
  const business = createCentreKysely(businessPool);
  const bank = createSystemBankKysely(bankPool);
  try {
    const platformBanks = await business
      .selectFrom('question_banks')
      .select('id')
      .where('scope', '=', 'platform')
      .where('bank_kind', '=', 'question')
      .execute();
    const platformBankIds = platformBanks.map((row) => row.id);
    const categories =
      platformBankIds.length === 0
        ? []
        : await business
            .selectFrom('question_categories')
            .select('id')
            .where('bank_id', 'in', platformBankIds)
            .execute();
    const categoryIds = categories.map((row) => row.id);
    const questions =
      categoryIds.length === 0
        ? []
        : await business
            .selectFrom('question')
            .select(['id', 'qtype'])
            .where('category', 'in', categoryIds)
            .execute();
    const questionIds = questions.map((row) => row.id);
    const entries =
      questionIds.length === 0
        ? []
        : await business
            .selectFrom('question_bank_entries')
            .select([
              'question_id as questionId',
              'status',
              'withdrawn_reason as withdrawnReason',
              'withdrawn_by as withdrawnBy',
              'withdrawn_at as withdrawnAt',
            ])
            .where('question_id', 'in', questionIds)
            .execute();
    const entryByQuestion = new Map(entries.map((row) => [row.questionId, row]));
    const versions =
      questionIds.length === 0
        ? []
        : await business
            .selectFrom('question_versions')
            .select([
              'id',
              'question_id as questionId',
              'version',
              'question_text as questionText',
              'general_feedback as generalFeedback',
              'stimulus_id as stimulusId',
            ])
            .where('question_id', 'in', questionIds)
            .execute();
    const versionIds = versions.map((row) => row.id);
    const answers =
      versionIds.length === 0
        ? []
        : await business
            .selectFrom('question_answers')
            .select([
              'question_version_id as questionVersionId',
              'answer',
              'is_correct as isCorrect',
              'feedback',
              'sort_order as sortOrder',
            ])
            .where('question_version_id', 'in', versionIds)
            .execute();
    const answerKeys =
      versionIds.length === 0
        ? []
        : await business
            .selectFrom('question_answer_keys')
            .select(['question_version_id as questionVersionId', 'guidance', 'solution'])
            .where('question_version_id', 'in', versionIds)
            .execute();
    const multichoiceOptions =
      versionIds.length === 0
        ? []
        : await business
            .selectFrom('qtype_multichoice_options')
            .select([
              'question_version_id as questionVersionId',
              'shuffle_answers as shuffleAnswers',
              'answer_numbering as answerNumbering',
              'correct_feedback as correctFeedback',
              'incorrect_feedback as incorrectFeedback',
              'show_standard_instruction as showStandardInstruction',
            ])
            .where('question_version_id', 'in', versionIds)
            .execute();
    const shortanswerOptions =
      versionIds.length === 0
        ? []
        : await business
            .selectFrom('qtype_shortanswer_options')
            .select([
              'question_version_id as questionVersionId',
              'use_case as useCase',
              'numeric_answer as numericAnswer',
              'numeric_max_length as numericMaxLength',
              'numeric_allow_sign as numericAllowSign',
              'numeric_allow_decimal as numericAllowDecimal',
            ])
            .where('question_version_id', 'in', versionIds)
            .execute();
    const essayOptions =
      versionIds.length === 0
        ? []
        : await business
            .selectFrom('qtype_essay_options')
            .select([
              'question_version_id as questionVersionId',
              'response_format as responseFormat',
              'response_required as responseRequired',
              'response_field_lines as responseFieldLines',
              'min_word_limit as minWordLimit',
              'max_word_limit as maxWordLimit',
              'grader_info as graderInfo',
              'response_template as responseTemplate',
            ])
            .where('question_version_id', 'in', versionIds)
            .execute();
    const stimulusIds = [...new Set(versions.map((row) => row.stimulusId).filter((id): id is string => id !== null))];
    const stimulusRows =
      stimulusIds.length === 0
        ? []
        : await business.selectFrom('stimuli').select(['id', 'content']).where('id', 'in', stimulusIds).execute();
    const stimulusById = new Map(stimulusRows.map((row) => [row.id, row.content]));
    const links =
      questionIds.length === 0
        ? []
        : await business
            .selectFrom('question_learning_outcomes')
            .select([
              'question_id as questionId',
              'learning_outcome_id as learningOutcomeId',
              'cognitive_level as cognitiveLevel',
            ])
            .where('question_id', 'in', questionIds)
            .execute();

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
        .insertInto('system_questions')
        .values({
          id: q.id,
          qtype: q.qtype,
          status: bankStatus,
          withdrawn_reason: entry?.withdrawnReason ?? null,
          withdrawn_by: entry?.withdrawnBy ?? null,
          withdrawn_at: entry?.withdrawnAt ?? null,
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            qtype: q.qtype,
            status: bankStatus,
            withdrawn_reason: entry?.withdrawnReason ?? null,
            withdrawn_by: entry?.withdrawnBy ?? null,
            withdrawn_at: entry?.withdrawnAt ?? null,
          }),
        )
        .execute();
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
        // Cột `package` là jsonb: serialize tường minh kèm `::jsonb`
        // như mọi đường ghi jsonb của hệ (driver `pg` không tự
        // stringify giá trị object do Kysely truyền xuống).
        const packageValue = sql<JsonValue>`${JSON.stringify(pkg)}::jsonb`;
        await bank
          .insertInto('system_question_versions')
          .values({
            id: version.id,
            question_id: q.id,
            version: version.version,
            checksum,
            package: packageValue,
          })
          .onConflict((oc) =>
            oc.column('id').doUpdateSet({ question_id: q.id, version: version.version, checksum, package: packageValue }),
          )
          .execute();
        await bank
          .deleteFrom('system_question_version_outcomes')
          .where('version_id', '=', version.id)
          .execute();
        if (questionLinks.length > 0) {
          await bank.insertInto('system_question_version_outcomes').values(
            questionLinks.map((link) => ({
              version_id: version.id,
              outcome_id: link.outcomeId,
              cognitive_level: link.cognitiveLevel,
            })),
          ).execute();
        }
        migratedVersions += 1;
      }
    }

    let packageInfo: { version: string; outcomes: number } | null = null;
    if (packageVersion) {
      const subjectRows = await business.selectFrom('subjects').select(['id', 'slug']).execute();
      const subjectIds = subjectRows.map((row) => row.id);
      const curriculumRows =
        subjectIds.length === 0
          ? []
          : await business
              .selectFrom('curricula')
              .select(['id', 'subject_id as subjectId', 'grade'])
              .where('subject_id', 'in', subjectIds)
              .execute();
      const curriculumIds = curriculumRows.map((row) => row.id);
      const nodeRows =
        curriculumIds.length === 0
          ? []
          : await business
              .selectFrom('curriculum_nodes')
              .select([
                'id',
                'curriculum_id as curriculumId',
                'parent_id as parentId',
                'title',
                'kind',
                'position',
                'duration_periods as durationPeriods',
                'duration_percent as durationPercent',
              ])
              .where('curriculum_id', 'in', curriculumIds)
              .execute();
      const nodeIds = nodeRows.map((row) => row.id);
      const outcomeRows =
        nodeIds.length === 0
          ? []
          : await business
              .selectFrom('learning_outcomes')
              .select(['id', 'node_id as nodeId', 'position', 'content', 'source_kind as sourceKind', 'source_ref as sourceRef'])
              .where('node_id', 'in', nodeIds)
              .where('tenant_id', 'is', null)
              .where('retired_at', 'is', null)
              .execute();
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
      const pkgRow = await bank
        .insertInto('system_outcome_packages')
        .values({
          version: packageVersion,
          scope: 'all',
          checksum,
          outcome_count: packageOutcomes.length,
          created_by: null,
        })
        .onConflict((oc) => oc.column('version').doNothing())
        .returningAll()
        .executeTakeFirst();
      if (pkgRow) {
        if (packageCurricula.length > 0) {
          await bank.insertInto('system_outcome_package_curricula').values(
            packageCurricula.map((row) => ({
              package_id: pkgRow.id,
              curriculum_id: row.curriculumId,
              subject_slug: row.subjectSlug,
              grade: row.grade,
            })),
          ).execute();
        }
        if (packageNodes.length > 0) {
          await bank.insertInto('system_outcome_package_nodes').values(
            packageNodes.map((row) => ({
              package_id: pkgRow.id,
              node_id: row.nodeId,
              curriculum_id: row.curriculumId,
              parent_id: row.parentId,
              title: row.title,
              kind: row.kind,
              position: row.position,
              duration_periods: row.durationPeriods,
              duration_percent: row.durationPercent,
            })),
          ).execute();
        }
        if (packageOutcomes.length > 0) {
          await bank.insertInto('system_outcome_package_outcomes').values(
            packageOutcomes.map((row) => ({
              package_id: pkgRow.id,
              outcome_id: row.outcomeId,
              node_id: row.nodeId,
              position: row.position,
              // Cột `content` là jsonb (tài liệu YCCĐ): serialize
              // tường minh kèm `::jsonb` như cột `package` ở trên.
              content: sql<JsonValue>`${JSON.stringify(row.content)}::jsonb`,
              source_kind: row.sourceKind,
              source_ref: row.sourceRef,
            })),
          ).execute();
        }
        packageInfo = { version: packageVersion, outcomes: packageOutcomes.length };
      } else {
        console.log(`  outcome package: version=${packageVersion} already exists, skipped`);
      }
    }

    const afterQuestions = await bank.selectFrom('system_questions').select('id').execute();
    const afterVersions = await bank.selectFrom('system_question_versions').select('id').execute();
    const afterLinks = await bank.selectFrom('system_question_version_outcomes').select('id').execute();
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
