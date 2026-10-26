import { useState } from 'react';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button, buttonVariants } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import { Skeleton } from '@lms/ui/components/skeleton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { createClassFeePayment, fetchClassPublic, fetchPayment, type ClassFeePaymentView } from '#lib/classes';
import { queryKeys } from '#lib/query-keys';

/**
 * Trang CÔNG KHAI của lớp để mua gói học phí (CLASS-3, issue #184).
 *
 * Flow:
 *  1. Nạp gói công khai của lớp (`GET /classes/:id/public`) — server đã
 *     suy sẵn quan hệ của người gọi với lớp: trang chỉ dựng hiển thị
 *     theo `isMember` / `canPurchase` / `feeEnabled` / `status`, không
 *     tự diễn giải lại luật (quyền thật vẫn gác ở API).
 *  2. Chưa ghi danh + lớp đang bán gói → hiện học phí và nút thanh
 *     toán. Bấm nút = tạo payment `class_fee` (POST
 *     /payments/class-fee/:classId) rồi hiện mã VietQR + mã thanh
 *     toán để học sinh quét bằng ứng dụng ngân hàng.
 *  3. Sau khi có payment, trang poll trạng thái payment mỗi 3 giây:
 *     đối soát SePay khớp đủ 3 điều kiện ở phía API mới lật payment
 *     sang `succeeded` và kích hoạt ghi danh cấp lớp — trang thấy
 *     `succeeded` thì báo đã vào lớp và nạp lại gói công khai (lúc này
 *     `isMember` = true).
 *  4. Đã ghi danh ACTIVE → hiện trạng thái đã ghi danh + nút vào lớp,
 *     TUYỆT ĐỐI không hiện nút mua lại.
 *
 * Bất biến hiển thị: trang này không bao giờ tự ghi danh hay tự đánh
 * dấu đã thanh toán — mọi trạng thái đều đọc từ API.
 */
export function ClassPublicPage() {
  const { t } = useTranslation('app');
  const { id } = useParams<{ id: string }>();
  const classId = id ?? '';
  const queryClient = useQueryClient();
  const [payment, setPayment] = useState<ClassFeePaymentView | null>(null);
  const [payError, setPayError] = useState<string | null>(null);

  const publicQuery = useQuery({
    queryKey: queryKeys.classPublic(classId),
    queryFn: () => fetchClassPublic(classId),
    enabled: Boolean(classId),
  });

  // Poll trạng thái payment sau khi tạo: chỉ chạy khi payment đang chờ
  // đối soát; succeeded là trạng thái kết thúc của vòng poll này.
  const statusQuery = useQuery({
    queryKey: ['payments', payment?.id ?? ''],
    queryFn: () => fetchPayment(payment!.id),
    enabled: Boolean(payment) && payment!.status === 'pending',
    refetchInterval: 3000,
  });
  const livePayment = statusQuery.data ?? payment;
  const succeeded = livePayment?.status === 'succeeded';

  const buyMutation = useMutation({
    mutationFn: () => createClassFeePayment(classId),
    onSuccess: (created) => {
      setPayError(null);
      setPayment(created);
    },
    onError: () => setPayError(t('classPublicPayFailed')),
  });

  if (succeeded && publicQuery.data && !publicQuery.data.isMember) {
    // Payment đã khớp: nạp lại gói công khai để chuyển sang trạng thái
    // thành viên (server là nguồn sự thật của roster).
    void queryClient.invalidateQueries({ queryKey: queryKeys.classPublic(classId) });
  }

  const pub = publicQuery.data;

  return (
    <PageShell width="narrow">
      <PageHeader title={pub?.name ?? t('classPublicFeeLabel')} description={pub?.schoolYear ?? undefined} />
      {publicQuery.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : publicQuery.isError || !pub ? (
        <Alert variant="destructive">
          <AlertDescription>{t('classPublicLoadFailed')}</AlertDescription>
        </Alert>
      ) : (
        <Card>
          {/* Tên lớp chỉ hiện ở PageHeader phía trên — không lặp lại
              trong thẻ để trang có đúng một tiêu đề. */}
          <CardContent className="flex flex-col gap-4 pt-6">
            <div className="flex flex-col gap-1 text-sm">
              <p className="text-muted-foreground">{t('classPublicOwner', { name: pub.ownerName })}</p>
              {pub.description ? <p>{pub.description}</p> : null}
            </div>

            {pub.isMember || succeeded ? (
              <div className="flex flex-col gap-3">
                <Alert>
                  <AlertDescription>{succeeded ? t('classPublicPaySucceeded') : t('classPublicMember')}</AlertDescription>
                </Alert>
                <div>
                  <Link className={buttonVariants()} to={`/classes/${pub.classId}`}>
                    {t('classPublicGoToClass')}
                  </Link>
                </div>
              </div>
            ) : pub.status === 'archived' ? (
              <Alert>
                <AlertDescription>{t('classPublicArchived')}</AlertDescription>
              </Alert>
            ) : !pub.feeEnabled ? (
              <p className="text-sm text-muted-foreground">{t('classPublicNoFee')}</p>
            ) : livePayment ? (
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm">{t('classPublicScanHint')}</p>
                {livePayment.vietqrPayload ? (
                  <QRCodeSVG value={livePayment.vietqrPayload} size={220} role="img" aria-label="VietQR" />
                ) : null}
                {livePayment.paymentCode ? (
                  <p className="text-sm">
                    {t('classPublicPaymentCode')}: <strong>{livePayment.paymentCode}</strong>
                  </p>
                ) : null}
                <p className="text-sm text-muted-foreground">{t('classPublicPayPending')}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-base">
                  {t('classPublicFeeLabel')}:{' '}
                  <strong>
                    {(pub.feeCost ?? 0).toLocaleString()} {pub.feeCurrency}
                  </strong>
                </p>
                <p className="text-sm text-muted-foreground">{t('classPublicBuyHint')}</p>
                {payError ? (
                  <Alert variant="destructive">
                    <AlertDescription>{payError}</AlertDescription>
                  </Alert>
                ) : null}
                <div>
                  <Button type="button" disabled={buyMutation.isPending} onClick={() => buyMutation.mutate()}>
                    {t('classPublicBuy')}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}

export default ClassPublicPage;
