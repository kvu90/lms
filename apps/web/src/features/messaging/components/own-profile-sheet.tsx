import { useState } from 'react';
import { X } from 'lucide-react';
import { Avatar, AvatarFallback } from '@lms/ui/components/avatar';
import { Button } from '@lms/ui/components/button';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Separator } from '@lms/ui/components/separator';
import { Sheet, SheetContent, SheetTitle } from '@lms/ui/components/sheet';
import { Textarea } from '@lms/ui/components/textarea';
import { cn } from '@lms/ui/lib/utils';
import { useTranslation } from 'react-i18next';
import { PRESENCE_DOT_CLASS, initialsOf, presenceLabelKey } from '../utils/utils';
import type { PresenceStatus } from '../types/types';

/** Hai mức hiện diện NỐI THẬT với presence của hệ: trực tuyến (giữ socket) và ngoại tuyến (ngắt socket). */
export type SelfPresenceChoice = 'online' | 'offline';

/**
 * Sheet hồ sơ của CHÍNH người xem, mở từ nút avatar ở đầu cột danh
 * sách (giai đoạn 2 của vòng sửa PR #610 — mục T-18/T-19/T-20 của
 * đợt rà soát hành vi bản demo):
 *
 * - Hình dạng bám bản demo: sheet phải bề rộng w-80, đầu sheet dính
 *   gồm avatar lớn kèm chấm trạng thái, tên là ô nhập không viền
 *   ngay trong đầu sheet và dòng định danh phụ dưới tên; thân là
 *   các trường có nhãn theo đúng thứ tự của demo (Avatar URL,
 *   About, Email, Phone, Company, Country, Website, Location,
 *   Timezone, Availability), rồi mục Status với lưới 2 cột bốn nút
 *   trạng thái (online/away/busy/offline) mang đúng màu chấm của
 *   bản đồ hiện diện, và nút Save changes ở đáy.
 * - Giá trị khởi tạo chỉ lấy từ dữ kiện THẬT trang đã có (tên hiển
 *   thị và email của phiên đăng nhập); các trường hệ chưa có nguồn
 *   dữ kiện thì để trống — không bịa giá trị.
 * - Nút Save changes để ở trạng thái VÔ HIỆU có chủ đích: đường sửa
 *   hồ sơ thuộc khu vực tài khoản, ngoài phạm vi PR này — đây là
 *   ngoại lệ có tên ghi trong thân PR, cùng tiền lệ khối liên kết
 *   mời ở sheet Tin nhắn mới.
 * - Bộ chọn trạng thái hiện diện: hai mức online/offline NỐI THẬT
 *   (trang chứa đổi nối socket realtime tương ứng — chọn offline là
 *   ngắt socket nên presence thật của người xem tắt ở mọi bề mặt,
 *   chọn online là nối lại); hai mức away/busy CHƯA có dữ kiện
 *   presence tương ứng ở backend (presence hiện hành chỉ có
 *   online/offline) nên dựng đúng hình dạng nhưng VÔ HIỆU — ngoại
 *   lệ có tên thứ hai ghi trong thân PR.
 */

interface OwnProfileSheetProps {
  /** Sheet đang mở hay không (trạng thái do khung trái giữ). */
  open: boolean;
  /** Đổi trạng thái mở (đóng từ nút X hoặc tương tác ngoài sheet). */
  onOpenChange: (open: boolean) => void;
  /** Tên hiển thị hiện tại của người xem (khởi tạo trường tên). */
  name: string;
  /** Định danh phụ dưới tên (`@username`); null thì không dựng dòng. */
  usernameLine: string | null;
  /** Email của phiên đăng nhập (khởi tạo trường Email). */
  email: string | null;
  /** Mức hiện diện người xem đang chọn (online/offline nối thật). */
  selfPresence: SelfPresenceChoice;
  /** Chọn mức hiện diện nối thật (trang chứa đổi nối socket). */
  onSelfPresenceChange: (presence: SelfPresenceChoice) => void;
}

/** Bốn mức trạng thái theo đúng thứ tự và tập của bản demo. */
const SELF_STATUSES: PresenceStatus[] = ['online', 'away', 'busy', 'offline'];

/**
 * Sheet hồ sơ của chính người xem (xem docblock của file).
 *
 * @param props - Trạng thái mở, dữ kiện định danh khởi tạo và cặp
 *   giá trị/handler của bộ chọn hiện diện nối thật.
 * @returns Sheet trượt từ phải theo hình dạng bản demo.
 */
export function OwnProfileSheet({
  open, onOpenChange, name, usernameLine, email, selfPresence, onSelfPresenceChange,
}: OwnProfileSheetProps) {
  const { t } = useTranslation('app');
  // Giá trị các trường là trạng thái soạn THUẦN TRÌNH BÀY của
  // sheet. Tên và Email có dữ kiện thật từ phiên nên giữ nháp
  // dạng null-khi-chưa-đụng: chưa đụng thì hiện giá trị thật,
  // người dùng gõ thì nháp thắng — không cần hiệu ứng đồng bộ
  // nào. Các trường chưa có nguồn dữ kiện thì để trống. Nút lưu
  // đang vô hiệu nên không giá trị nào rời khỏi sheet này.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState('');
  const [about, setAbout] = useState('');
  const [emailDraft, setEmailDraft] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [company, setCompany] = useState('');
  const [country, setCountry] = useState('');
  const [website, setWebsite] = useState('');
  const [location, setLocation] = useState('');
  const [timezone, setTimezone] = useState('');
  const [availability, setAvailability] = useState('');
  const draftName = nameDraft ?? name;
  const draftEmail = emailDraft ?? email ?? '';

  /** Các trường đơn dòng theo đúng thứ tự của bản demo (sau About và trước Status). */
  const fields: { key: string; label: string; value: string; set: (value: string) => void }[] = [
    { key: 'avatarUrl', label: t('profileAvatarUrl'), value: avatarUrl, set: setAvatarUrl },
    { key: 'email', label: t('profileEmail'), value: draftEmail, set: setEmailDraft },
    { key: 'phone', label: t('profilePhone'), value: phone, set: setPhone },
    { key: 'company', label: t('profileCompany'), value: company, set: setCompany },
    { key: 'country', label: t('profileCountry'), value: country, set: setCountry },
    { key: 'website', label: t('profileWebsite'), value: website, set: setWebsite },
    { key: 'location', label: t('profileLocation'), value: location, set: setLocation },
    { key: 'timezone', label: t('profileTimezone'), value: timezone, set: setTimezone },
    { key: 'availability', label: t('profileAvailability'), value: availability, set: setAvailability },
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-80 p-0" showCloseButton={false}>
        <SheetTitle className="sr-only">{t('myProfile')}</SheetTitle>
        <div className="flex max-h-dvh flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/*
              Đầu sheet dính trên cùng như bản demo: avatar lớn
              kèm chấm theo mức hiện diện ĐANG CHỌN, tên là ô nhập
              không viền (soạn thuần trình bày — nút lưu vô hiệu),
              dòng định danh phụ dưới tên, nút đóng ở góc phải.
            */}
            <div className="sticky top-0 z-10 flex items-start gap-3 border-b bg-background px-4 py-4">
              <span className="relative shrink-0">
                <Avatar size="lg">
                  <AvatarFallback>{initialsOf(draftName || name)}</AvatarFallback>
                </Avatar>
                <span
                  className={cn(
                    'absolute right-0 bottom-0 size-3 rounded-full ring-2 ring-background',
                    PRESENCE_DOT_CLASS[selfPresence],
                  )}
                />
              </span>
              <div className="min-w-0 flex-1">
                <Input
                  aria-label={t('fullName')}
                  value={draftName}
                  onChange={(e) => setNameDraft(e.target.value)}
                  className="h-auto truncate rounded-none border-none p-0 leading-5 font-medium shadow-none ring-0 focus-visible:ring-0"
                />
                {usernameLine ? (
                  <p className="truncate text-xs wrap-break-word text-muted-foreground">{usernameLine}</p>
                ) : null}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('closeDialog')}
                onClick={() => onOpenChange(false)}
              >
                <X aria-hidden />
              </Button>
            </div>
            <div className="space-y-4 px-4 py-4">
              {fields.slice(0, 1).map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <Label htmlFor={`own-profile-${field.key}`}>{field.label}</Label>
                  <Input id={`own-profile-${field.key}`} value={field.value} onChange={(e) => field.set(e.target.value)} />
                </div>
              ))}
              <div className="space-y-1.5">
                <Label htmlFor="own-profile-about">{t('profileBio')}</Label>
                <Textarea id="own-profile-about" value={about} onChange={(e) => setAbout(e.target.value)} className="min-h-20" />
              </div>
              {fields.slice(1).map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <Label htmlFor={`own-profile-${field.key}`}>{field.label}</Label>
                  <Input id={`own-profile-${field.key}`} value={field.value} onChange={(e) => field.set(e.target.value)} />
                </div>
              ))}
              <Separator />
              {/*
                Bộ chọn trạng thái hiện diện của chính người xem:
                lưới 2 cột bốn mức như bản demo. Online/offline là
                nút THẬT (đổi nối socket qua trang chứa); away/busy
                vô hiệu vì backend chưa có dữ kiện tương ứng —
                ngoại lệ có tên trong thân PR.
              */}
              <div className="space-y-2">
                <p className="text-sm leading-none font-medium">{t('memberProfilePresence')}</p>
                <div className="grid grid-cols-2 gap-2">
                  {SELF_STATUSES.map((status) => {
                    const wired = status === 'online' || status === 'offline';
                    const selected = selfPresence === status;
                    return (
                      <button
                        key={status}
                        type="button"
                        disabled={!wired}
                        aria-pressed={wired ? selected : undefined}
                        onClick={() => {
                          if (status === 'online' || status === 'offline') onSelfPresenceChange(status);
                        }}
                        className={cn(
                          'flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-medium capitalize transition-colors',
                          selected
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:bg-muted',
                        )}
                      >
                        <span className={cn('size-2 rounded-full', PRESENCE_DOT_CLASS[status])} />
                        {t(presenceLabelKey(status))}
                      </button>
                    );
                  })}
                </div>
              </div>
              {/*
                Nút lưu VÔ HIỆU có chủ đích: đường sửa hồ sơ thuộc
                khu vực tài khoản, ngoài phạm vi PR này (ngoại lệ
                có tên trong thân PR).
              */}
              <Button type="button" className="w-full" disabled>
                {t('saveChanges')}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
