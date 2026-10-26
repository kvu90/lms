import { useState } from 'react';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { useTranslation } from 'react-i18next';
import { CollapsibleSection } from '../components/collapsible-section';
import { SettingsShell } from '../components/settings-shell';
import '../i18n';
import {
  preferenceKey,
  useMessagePreferences,
  useNotificationCourseOverrides,
  useSetMessagePreference,
  useSetNotificationCourseOverride,
  type EmailFrequency,
  type NotificationCourseOverrideView,
  type NotificationGroupFilter,
  type NotificationPreferenceView,
} from '#lib/notifications';

/** Ba nhóm provider của registry (NB-2) theo đúng thứ tự trình bày đã chốt. */
const GROUP_ORDER: NotificationGroupFilter[] = ['learning', 'people', 'system'];

/**
 * Trạng thái gộp của một NHÓM provider cho lớp 1 (theo nhóm):
 * - `popupState`: true/false khi mọi dòng còn chỉnh được đồng nhất,
 *   'mixed' khi lệch nhau (đã có tuỳ chỉnh từng loại), null khi nhóm
 *   không còn dòng nào chỉnh được (mọi loại đều bị admin tắt ở site).
 * - `emailState`: cùng quy ước, chỉ tính trên các dòng có kênh email.
 * Dòng bị admin tắt ở cấp site (NB-7, `siteEnabled=false`) bị LOẠI
 * khỏi phép gộp: giá trị tuỳ chọn cá nhân của chúng không còn hiệu
 * lực phát nào để trình bày thành trạng thái nhóm.
 */
interface GroupSummary {
  group: NotificationGroupFilter;
  rows: NotificationPreferenceView[];
  changeable: NotificationPreferenceView[];
  popupState: boolean | 'mixed' | null;
  emailState: EmailFrequency | 'mixed' | null;
  hasMandatory: boolean;
  customized: boolean;
}

/** Gộp trạng thái một nhóm từ các dòng tuỳ chọn thật API trả về (không có trạng thái nhóm lưu riêng ở đâu cả). */
function summarizeGroup(group: NotificationGroupFilter, rows: NotificationPreferenceView[]): GroupSummary {
  const changeable = rows.filter((r) => r.siteEnabled);
  const popupValues = new Set(changeable.map((r) => r.popupEnabled));
  const popupState: GroupSummary['popupState'] =
    changeable.length === 0 ? null : popupValues.size > 1 ? 'mixed' : changeable[0]!.popupEnabled;
  const emailValues = new Set(
    changeable.filter((r) => r.emailFrequency !== null).map((r) => r.emailFrequency as EmailFrequency),
  );
  const emailState: GroupSummary['emailState'] =
    emailValues.size === 0 ? null : emailValues.size > 1 ? 'mixed' : [...emailValues][0]!;
  return {
    group,
    rows,
    changeable,
    popupState,
    emailState,
    hasMandatory: rows.some((r) => r.mandatoryInApp),
    customized: popupState === 'mixed' || emailState === 'mixed',
  };
}

/**
 * Mục THÔNG BÁO của khu Cài đặt (`/settings/notifications`, issue
 * #288) — bề mặt tuỳ chọn thông báo phía người dùng, chuyển từ trang
 * `/notifications` (nay chỉ còn trung tâm thông báo) sang đây.
 *
 * Mô hình HAI LỚP trên đúng dữ liệu registry v2 sẵn có (20 provider /
 * 3 nhóm; API `/messages/preferences` giữ nguyên, không có trạng thái
 * "theo nhóm" lưu ở server):
 *
 * - Lớp 1 (bề mặt chính): một hàng cho mỗi nhóm — công tắc popup +
 *   tần suất email THEO NHÓM. Trạng thái nhóm là giá trị SUY RA phía
 *   client từ các dòng thật: đồng nhất thì hiện giá trị đó, lệch nhau
 *   (đã tuỳ chỉnh từng loại) thì hiện "Đã tuỳ chỉnh". Đổi ở lớp 1 =
 *   ghi đồng loạt qua API hiện có (PUT từng provider trong nhóm, bỏ
 *   qua loại bắt buộc khi tắt popup và loại admin đã tắt) — đúng
 *   khuyến nghị research #288 mục 4.3.
 * - Lớp 2 (mục thu/mở "Tuỳ chỉnh từng loại"): nguyên bảng theo loại
 *   như v2 — tuỳ chỉnh ở đây là PUT cho đúng một provider nên THẮNG
 *   cài đặt nhóm: sau khi chỉnh, hàng nhóm ở lớp 1 chuyển sang trạng
 *   thái "Đã tuỳ chỉnh" thay vì một giá trị giả.
 *
 * Các luật cứng chỉ HIỂN THỊ, không đổi: loại bắt buộc P2 khoá popup
 * kèm nhãn "Bắt buộc"; loại bị admin tắt ở cấp site (NB-7, trường
 * `siteEnabled` API trả về từ đúng chính sách `notify()` tôn trọng)
 * hiện nhãn "Admin đã tắt ở cấp site" và vô hiệu hoá điều khiển.
 * Dưới hai lớp là mục riêng "Ngoại lệ theo khoá học" (NB-4/P3) giữ
 * nguyên hành vi. Học sinh: API trả danh sách theo loại rỗng nên
 * trang chỉ hiện ghi chú tối thiểu + mục ngoại lệ theo khoá (NB-7).
 */
export function SettingsNotificationsPage() {
  const { t, i18n } = useTranslation('app');
  const [savingPrefs, setSavingPrefs] = useState<ReadonlySet<string>>(new Set());
  const [savingGroups, setSavingGroups] = useState<ReadonlySet<string>>(new Set());
  const [savingOverrides, setSavingOverrides] = useState<ReadonlySet<string>>(new Set());
  const [prefError, setPrefError] = useState<string | null>(null);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const prefsQuery = useMessagePreferences();
  const overridesQuery = useNotificationCourseOverrides();
  const preferenceMutation = useSetMessagePreference();
  const overrideMutation = useSetNotificationCourseOverride();

  const prefs = prefsQuery.data ?? [];
  const overrideCourses = overridesQuery.data ?? [];
  const loadError = prefsQuery.isError || overridesQuery.isError ? t('notificationsLoadFailed') : null;

  const groupLabel: Record<NotificationGroupFilter, string> = {
    learning: t('notificationsGroupLearning'),
    people: t('notificationsGroupPeople'),
    system: t('notificationsGroupSystem'),
  };
  const localized = (row: NotificationPreferenceView) =>
    i18n.language?.startsWith('en')
      ? { label: row.label.en, description: row.description.en }
      : { label: row.label.vi, description: row.description.vi };

  const summaries = GROUP_ORDER.map((group) => summarizeGroup(group, prefs.filter((p) => p.group === group))).filter(
    (s) => s.rows.length > 0,
  );
  const prefSections = GROUP_ORDER.map((group) => ({
    group,
    rows: prefs.filter((p) => p.group === group),
  })).filter((section) => section.rows.length > 0);

  /** Lưu một patch tuỳ chọn của một provider; cờ đang-lưu theo (provider, trường). */
  function savePreference(row: NotificationPreferenceView, field: 'popup' | 'email', patch: { popupEnabled?: boolean; emailFrequency?: EmailFrequency }) {
    const key = `${preferenceKey(row)}|${field}`;
    if (savingPrefs.has(key)) return;
    setPrefError(null);
    setSavingPrefs((prev) => new Set(prev).add(key));
    // Cập nhật lạc quan + hoàn lại khi lỗi nằm trong mutation ở
    // lib/notifications.ts; ở đây chỉ lo cờ đang-lưu và lỗi riêng
    // của khu vực tuỳ chọn.
    preferenceMutation.mutate(
      { provider: row.provider, patch },
      {
        onError: () => setPrefError(t('preferenceSaveFailed')),
        onSettled: () =>
          setSavingPrefs((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          }),
      },
    );
  }

  function togglePopup(row: NotificationPreferenceView) {
    savePreference(row, 'popup', { popupEnabled: !row.popupEnabled });
  }

  function changeEmailFrequency(row: NotificationPreferenceView, frequency: EmailFrequency) {
    savePreference(row, 'email', { emailFrequency: frequency });
  }

  /**
   * Ghi một thay đổi THEO NHÓM (lớp 1): fan-out thành PUT cho từng
   * provider còn chỉnh được trong nhóm mà giá trị hiện tại khác giá
   * trị đích — chạy TUẦN TỰ để mỗi mutation lạc quan ở lib chụp đúng
   * trạng thái cache trước nó, tránh các bản chụp chồng nhau ghi đè
   * khi hoàn lại. Loại bắt buộc P2 không bao giờ bị tắt popup qua
   * đường nhóm (bật thì vô hại vì chúng vốn luôn bật); loại admin đã
   * tắt ở cấp site bị bỏ qua hẳn — server không phát chúng nữa nên
   * ghi tuỳ chọn cho chúng là vô nghĩa.
   */
  async function saveGroup(summary: GroupSummary, field: 'popup' | 'email', target: boolean | EmailFrequency) {
    if (savingGroups.has(summary.group)) return;
    setPrefError(null);
    setSavingGroups((prev) => new Set(prev).add(summary.group));
    try {
      for (const row of summary.changeable) {
        if (field === 'popup') {
          const targetPopup = target as boolean;
          if (row.popupEnabled === targetPopup) continue;
          if (!targetPopup && row.mandatoryInApp) continue;
          await preferenceMutation.mutateAsync({ provider: row.provider, patch: { popupEnabled: targetPopup } });
        } else {
          const targetFrequency = target as EmailFrequency;
          if (row.emailFrequency === null || row.emailFrequency === targetFrequency) continue;
          await preferenceMutation.mutateAsync({ provider: row.provider, patch: { emailFrequency: targetFrequency } });
        }
      }
    } catch {
      setPrefError(t('preferenceSaveFailed'));
    } finally {
      setSavingGroups((prev) => {
        const next = new Set(prev);
        next.delete(summary.group);
        return next;
      });
    }
  }

  /**
   * Bật/tắt tắt tiếng một khoá (NB-4): cập nhật lạc quan + hoàn lại
   * khi lỗi nằm trong mutation ở lib/notifications.ts; ở đây chỉ lo
   * cờ đang-lưu và thông báo lỗi riêng của khu vực ngoại lệ.
   */
  function toggleCourseMute(course: NotificationCourseOverrideView) {
    if (savingOverrides.has(course.courseId)) return;
    setOverrideError(null);
    setSavingOverrides((prev) => new Set(prev).add(course.courseId));
    overrideMutation.mutate(
      { courseId: course.courseId, mode: course.mode === 'mute' ? 'all' : 'mute' },
      {
        onError: () => setOverrideError(t('courseOverrideSaveFailed')),
        onSettled: () =>
          setSavingOverrides((prev) => {
            const next = new Set(prev);
            next.delete(course.courseId);
            return next;
          }),
      },
    );
  }

  return (
    <SettingsShell>
      {loadError ? (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('notificationPreferences')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {prefError ? (
            <Alert variant="destructive">
              <AlertDescription>{prefError}</AlertDescription>
            </Alert>
          ) : null}
          {/* NB-7: học sinh chỉ có bề mặt tối thiểu — API trả danh sách
              theo loại rỗng cho họ; trang nói rõ thay vì hiện một thẻ
              trống, bề mặt thật của họ là Ngoại lệ theo khoá ở dưới. */}
          {prefsQuery.isSuccess && prefs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('prefMinimalNote')}</p>
          ) : null}
          {/* Lớp 1 — theo nhóm: trạng thái suy ra từ các dòng thật;
              nhóm lệch giá trị thì báo "Đã tuỳ chỉnh" thay vì bịa một
              giá trị chung không có thật. */}
          {summaries.map((summary) => {
            const emailSaving = savingGroups.has(summary.group);
            return (
              <section key={summary.group} aria-label={groupLabel[summary.group]} className="space-y-2">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <h3 className="min-w-32 flex-1 text-sm font-semibold">{groupLabel[summary.group]}</h3>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      aria-label={`${groupLabel[summary.group]} — ${t('prefInApp')}`}
                      type="checkbox"
                      checked={summary.popupState === true}
                      disabled={summary.popupState === null || emailSaving}
                      ref={(el) => {
                        // Trạng thái lệch nhau (đã tuỳ chỉnh từng loại)
                        // hiện dạng indeterminate — không bật cũng
                        // không tắt, đúng sự thật của dữ liệu.
                        if (el) el.indeterminate = summary.popupState === 'mixed';
                      }}
                      onChange={(e) => void saveGroup(summary, 'popup', e.target.checked)}
                    />
                    {t('prefInApp')}
                  </label>
                  {summary.emailState !== null ? (
                    <label className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">{t('prefEmail')}</span>
                      <select
                        aria-label={`${groupLabel[summary.group]} — ${t('prefEmail')}`}
                        value={summary.emailState}
                        disabled={emailSaving}
                        onChange={(e) => void saveGroup(summary, 'email', e.target.value as EmailFrequency)}
                      >
                        {summary.emailState === 'mixed' ? (
                          <option value="mixed" disabled>
                            {t('prefGroupCustomized')}
                          </option>
                        ) : null}
                        <option value="immediate">{t('prefEmailImmediate')}</option>
                        <option value="daily">{t('prefEmailDaily')}</option>
                        <option value="off">{t('prefEmailOff')}</option>
                      </select>
                    </label>
                  ) : null}
                </div>
                {summary.customized ? (
                  <p className="text-xs text-muted-foreground">{t('prefGroupCustomizedNote')}</p>
                ) : null}
                {summary.hasMandatory ? (
                  <p className="text-xs text-muted-foreground">{t('prefGroupMandatoryNote')}</p>
                ) : null}
              </section>
            );
          })}
        </CardContent>
      </Card>
      {/* Lớp 2 — tuỳ chỉnh từng loại: nguyên bảng v2, chỉ mở khi giáo
          viên cần tinh chỉnh; PUT ở đây áp cho đúng một provider nên
          thắng cài đặt theo nhóm ở lớp 1. Học sinh không có lớp này
          (danh sách rỗng) — bề mặt của họ dừng ở ghi chú tối thiểu. */}
      {prefs.length > 0 ? (
        <CollapsibleSection
          title={t('prefCustomizeTitle')}
          description={t('prefCustomizeDescription')}
          open={customizeOpen}
          onOpenChange={setCustomizeOpen}
          contentClassName="space-y-6"
        >
          {prefSections.map((section) => (
            <section key={section.group} aria-label={groupLabel[section.group]} className="space-y-3">
              <h3 className="text-sm font-semibold">{groupLabel[section.group]}</h3>
              <div className="grid grid-cols-[1fr_auto_auto] items-start gap-x-4 gap-y-1 text-sm">
                <span className="text-xs font-medium uppercase text-muted-foreground">{t('prefType')}</span>
                <span className="text-xs font-medium uppercase text-muted-foreground">{t('prefInApp')}</span>
                <span className="text-xs font-medium uppercase text-muted-foreground">{t('prefEmail')}</span>
                {section.rows.map((row) => {
                  const text = localized(row);
                  const emailSaving = savingPrefs.has(`${preferenceKey(row)}|email`);
                  return [
                    <div key={`${row.provider}-label`} className="min-w-0 border-t pt-2">
                      <p className="font-medium">
                        {text.label}
                        {row.teacherOnly ? (
                          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal">{t('prefTeacherOnly')}</span>
                        ) : null}
                        {row.mandatoryInApp ? (
                          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal">{t('prefMandatory')}</span>
                        ) : null}
                        {!row.siteEnabled ? (
                          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal">{t('prefAdminDisabled')}</span>
                        ) : null}
                      </p>
                      <p className="text-muted-foreground">{text.description}</p>
                      {row.mandatoryInApp ? <p className="text-xs text-muted-foreground">{t('prefMandatoryNote')}</p> : null}
                      {!row.siteEnabled ? <p className="text-xs text-muted-foreground">{t('prefAdminDisabledNote')}</p> : null}
                    </div>,
                    <div key={`${row.provider}-popup`} className="border-t pt-2">
                      <input
                        aria-label={`${text.label} — ${t('prefInApp')}`}
                        type="checkbox"
                        checked={row.popupEnabled}
                        disabled={row.mandatoryInApp || !row.siteEnabled || savingPrefs.has(`${preferenceKey(row)}|popup`)}
                        onChange={() => togglePopup(row)}
                      />
                    </div>,
                    <div key={`${row.provider}-email`} className="border-t pt-2">
                      {row.emailFrequency !== null ? (
                        <>
                          <select
                            aria-label={`${text.label} — ${t('prefEmail')}`}
                            value={row.emailFrequency}
                            disabled={!row.siteEnabled || emailSaving}
                            onChange={(e) => changeEmailFrequency(row, e.target.value as EmailFrequency)}
                          >
                            <option value="immediate">{t('prefEmailImmediate')}</option>
                            <option value="daily">{t('prefEmailDaily')}</option>
                            <option value="off">{t('prefEmailOff')}</option>
                          </select>
                          {!row.emailAvailable ? (
                            <p className="mt-1 max-w-56 text-xs text-muted-foreground">{t('prefChannelUnavailable')}</p>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>,
                  ];
                })}
              </div>
            </section>
          ))}
        </CollapsibleSection>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('courseExceptionsTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('courseExceptionsDescription')}</p>
          {overrideError ? (
            <Alert variant="destructive">
              <AlertDescription>{overrideError}</AlertDescription>
            </Alert>
          ) : null}
          {overrideCourses.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('courseExceptionsEmpty')}</p>
          ) : (
            <ul className="space-y-2">
              {overrideCourses.map((course) => (
                <li key={course.courseId} className="flex items-center gap-3 border-t pt-2 text-sm">
                  <span className="min-w-0 flex-1 font-medium">
                    {course.courseName}
                    {course.mode === 'mute' ? (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal">{t('courseMutedBadge')}</span>
                    ) : null}
                  </span>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label={`${t('courseMuteLabel')}: ${course.courseName}`}
                      checked={course.mode === 'mute'}
                      disabled={savingOverrides.has(course.courseId)}
                      onChange={() => toggleCourseMute(course)}
                    />
                    {t('courseMuteLabel')}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </SettingsShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default SettingsNotificationsPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('settingsNotifications');
}
